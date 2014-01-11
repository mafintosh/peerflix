var peerSwarm = require('peer-wire-swarm');
var wire = require('peer-wire-protocol');
var hat = require('hat');
var path = require('path');
var os = require('os');
var fs = require('fs');
var numeral = require('numeral');
var bitfield = require('bitfield');
var readTorrent = require('read-torrent');
var optimist = require('optimist');
var speedometer = require('speedometer');
var once = require('once');
var net = require('net');
var createStorage = require('./storage');
var createServer = require('./server');

module.exports = function(filename, opts, ready) {
	if (!ready) {
		ready = opts;
		opts = null;
	}

	var peerflix = {}; // peerflix handle
	var options = opts || {};

	var MAX_PEERS = options.connections;
	var MIN_PEERS = 0;
	var MAX_QUEUED = 5;

	var BLOCK_SIZE = 16*1024; // used for finding offset prio
	var MIN_SPEED =  5*1024;
	var CHOKE_TIMEOUT = 5000;
	var PIECE_TIMEOUT = 30000;
	var FAST_PIECE_TIMEOUT = 10000;
	var HANDSHAKE_TIMEOUT = 5000;
	var PEER_ID = '-PF0005-'+hat(48);

	var biggest = function(torrent) {
		return torrent.files.reduce(function(biggest, file) {
			return biggest.length > file.length ? biggest : file;
		});
	};

	var noop = function() {};

	readTorrent(filename, function(err, torrent) {
		if (err) return ready(err);

		peerflix.torrent = torrent;
		var selected = peerflix.selected = (typeof(options.index)=='number') ? torrent.files[options.index] : biggest(torrent);
		var destination = peerflix.destination = options.path || path.join(os.tmpDir(), torrent.infoHash+'.'+selected.offset);
		var storage = peerflix.storage = createStorage(torrent, selected, { destination:destination });
		var server = peerflix.server = createServer(storage, selected, { buffer:options.buffer && numeral().unformat(options.buffer), port: options.port });
		var peers  = peerflix.peers = [];
		var destroyed = false;

		var speed = peerflix.speed = speedometer();
		peerflix.uploaded = 0;
		peerflix.downloaded = 0;
		peerflix.resyncs = 0;

		var have = bitfield(torrent.pieces.length);
		var requesting = {};

		storage.on('readable', function(i) {
			delete requesting[i];
			have.set(i);
			peers.forEach(function(peer) {
				peer.have(i);
			});
		});

		var remove = function(arr, item) {
			if (!arr) return false;
			var i = arr.indexOf(item);
			if (i === -1) return false;
			arr.splice(i, 1);
			return true;
		};
		var calcOffset = function(me) {
			var speed = me.speed();
			var time = MAX_QUEUED * BLOCK_SIZE / (speed || 1);
			var max = storage.missing.length > 60 ? storage.missing.length - 30 : storage.missing.length - 1;
			var data = 0;

			if (speed < MIN_SPEED) return max;

			peers.forEach(function(peer) {
				if (!peer.peerPieces[storage.missing[0]]) return;
				if (peer.peerChoking) return;
				if (me === peer || peer.speed() < speed) return;
				data += peer.speed() * time;
			});

			return Math.min(Math.floor(data / torrent.pieceLength), max);
		};
		var resync = function(offset) {
			var piece = server.position + offset;

			if (!requesting[piece]) return;
			if (storage.missing.length < 10) return;

			requesting[piece].forEach(function(peer) {
				if (peer.speed() > 2*BLOCK_SIZE) return;
				if (calcOffset(peer) <= offset) return;
				while (remove(requesting[piece], peer));
				peer.cancel();
				peerflix.resyncs++;
			});
		};
		var lastResync = 0;
		var resyncAll = function() {
			if (Date.now() - lastResync < 2000) return;
			lastResync = Date.now();
			for (var i = 0; i < 2; i++) {
				resync(i);
			}
		};

		var update = function() {
			peers.sort(function(a,b) {
				return b.downloaded - a.downloaded;
			});

			resyncAll();

			peers.forEach(function(peer) {
				if (peer.peerChoking) return;

				var select = function(force) {
					storage.missing.slice(calcOffset(peer)).some(function(piece) {
						if (peer.requests >= MAX_QUEUED) return true;
						if (!peer.peerPieces[piece]) return;

						var offset = storage.select(piece, force);
						if (offset === -1) return;

						requesting[piece] = requesting[piece] || [];
						requesting[piece].push(peer);

						peer.request(piece, offset, storage.sizeof(piece, offset), function(err, buffer) {
							remove(requesting[piece], peer);
							process.nextTick(update);
							if (err) return storage.deselect(piece, offset);
							storage.write(piece, offset, buffer);
						});
					});
				};

				select();
				if (!peer.requests && storage.missing.length < 30) select(true);
			});
		};

		var onconnection = function(connection, id, address) {
			if (!storage.missing.length) return;

			var protocol = wire();

			connection.pipe(protocol).pipe(connection);

			var ontimeout = connection.destroy.bind(connection);
			var timeout = setTimeout(ontimeout, HANDSHAKE_TIMEOUT);

			protocol.once('handshake', function() {
				clearTimeout(timeout);
				if (destroyed) return;

				peers.push(protocol);

				var onclose = once(function() {
					clearTimeout(timeout);
					peers.splice(peers.indexOf(protocol), 1);
					if (protocol.downloaded) sw.reconnect(address);
					process.nextTick(update);
				});

				connection.on('close', onclose);
				connection.on('error', onclose);
				protocol.once('finish', onclose);

				protocol.on('unchoke', update);
				protocol.on('have', update);

				var onchoketimeout = function() {
					if (peers.length > MIN_PEERS && sw.queued > 2 * (MAX_PEERS - peers.length)) return ontimeout();
					timeout = setTimeout(onchoketimeout, CHOKE_TIMEOUT);
				};

				protocol.on('choke', function() {
					clearTimeout(timeout);
					timeout = setTimeout(onchoketimeout, CHOKE_TIMEOUT);
				});

				protocol.on('unchoke', function() {
					clearTimeout(timeout);
				});

				protocol.once('interested', function() {
					protocol.unchoke();
				});

				timeout = setTimeout(onchoketimeout, CHOKE_TIMEOUT);
				protocol.setKeepAlive();
			});


			protocol.id = id;
			protocol.handshake(torrent.infoHash, PEER_ID);
			protocol.bitfield(have);
			protocol.interested();
			protocol.speed = speedometer();

			protocol.setTimeout(PIECE_TIMEOUT, function() {
				protocol.destroy();
			});

			protocol.on('download', function(bytes) {
				peerflix.downloaded += bytes;
				protocol.speed(bytes);
				speed(bytes);
			});

			protocol.on('upload', function(bytes) {
				peerflix.uploaded += bytes;
			});

			protocol.on('request', storage.read);
		};

		if (options.fastpeers) {
			if (!Array.isArray(options.fastpeers)) options.fastpeers = options.fastpeers.split(',');
			options.fastpeers.forEach(function(peer) {
				var socket = net.connect(peer.split(':')[1], peer.split(':')[0]);
				socket.on('connect', function() {
					onconnection(socket, peer, peer);
				});
				socket.on('error', noop);
			});
		}

		if (options.hasOwnProperty("dht") ? options.dht : true) {
			var sw = peerflix.swarm = peerSwarm(torrent.infoHash, {maxSize:MAX_PEERS});
			sw.on('connection', onconnection);
			sw.listen();
		}

		peerflix.destroy = function() {
			destroyed = true;
			peers.forEach(function(peer) {
				peer.destroy();
			});
			if (!peerflix.swarm) return;
			 // hackish
			peerflix.swarm.maxSize = 0;
			peerflix.swarm.connections.forEach(function(conn) {
				conn.destroy();
			});
			peerflix.swarm._sock.close();
			server.close();
		};

		ready(null, peerflix);
	});

	peerflix.clearCache = function() {
		if (fs.existsSync(peerflix.destination)) fs.unlinkSync(peerflix.destination);
	};

	return peerflix;
}
