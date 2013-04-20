#!/usr/bin/env node

var peerSwarm = require('peer-wire-swarm');
var wire = require('peer-wire-protocol');
var hat = require('hat');
var path = require('path');
var os = require('os');
var fs = require('fs');
var proc = require('child_process');
var address = require('network-address');
var numeral = require('numeral');
var clivas = require('clivas');
var bitfield = require('bitfield');
var readTorrent = require('read-torrent');
var optimist = require('optimist');
var speedometer = require('speedometer');
var once = require('once');
var os = require('os');
var createServer = require('./server');

var argv = optimist
	.usage('Usage: $0 torrent_file_or_url [options]')
	.alias('c', 'connections').describe('c', 'max connected peers').default('c', os.cpus().length > 1 ? 100 : 30)
	.alias('p', 'port').describe('p', 'change the http port').default('p', 8888)
	.alias('b', 'buffer').describe('b', 'change buffer size').default('b', '1.5MB')
	.alias('bp', 'path').describe('bp', 'change buffer file path')
	.alias('i', 'index').describe('i', 'changed streamed file (index)')
	.alias('q', 'quiet').describe('q', 'be quiet')
	.alias('v', 'vlc').describe('v', 'autoplay in vlc*')
	.alias('o', 'omx').describe('o', 'autoplay in omx**')
	.alias('j', 'jack').describe('j', 'autoplay in omx** using the audio jack')
	.argv;

var filename = argv._[0];

if (!filename) {
	optimist.showHelp();
	console.error('*Autoplay can take several seconds to start since it needs to wait for the first piece');
	console.error('*OMX player is the default Raspbian video player\n');
	process.exit(1);
}

var biggest = function(torrent) {
	return torrent.files.reduce(function(biggest, file) {
		return biggest.length > file.length ? biggest : file;
	});
};

var MAX_PEERS = argv.connections;
var MIN_PEERS = 0;
var MAX_QUEUED = 5;
var VLC_ARGS = '-q --video-on-top --play-and-exit';
var OMX_EXEC = argv.jack ? 'omxplayer -r -o local ' : 'omxplayer -r -o hdmi ';

var BLOCK_SIZE = 16*1024; // used for finding offset prio
var MIN_SPEED =  5*1024;
var CHOKE_TIMEOUT = 5000;
var PIECE_TIMEOUT = 30000;
var FAST_PIECE_TIMEOUT = 10000;
var HANDSHAKE_TIMEOUT = 5000;
var PEER_ID = '-PF0005-'+hat(48);

var noop = function() {};

readTorrent(filename, function(err, torrent) {
	if (err) throw err;

	var selected = (argv.index && torrent.files[argv.index]) || biggest(torrent);
	var destination = argv.bp || path.join(os.tmpDir(), torrent.infoHash+'.'+selected.offset);
	var server = createServer(torrent, selected, {destination:destination, buffer:argv.buffer && numeral().unformat(argv.buffer)});
	var peers = [];

	var speed = speedometer();
	var uploaded = 0;
	var downloaded = 0;
	var resyncs = 0;

	var have = bitfield(torrent.pieces.length);
	var requesting = {};

	server.on('readable', function(i) {
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
		var max = server.missing.length > 60 ? server.missing.length - 30 : server.missing.length - 1;
		var data = 0;

		if (speed < MIN_SPEED) return max;

		peers.forEach(function(peer) {
			if (!peer.peerPieces[server.missing[0]]) return;
			if (peer.peerChoking) return;
			if (me === peer || peer.speed() < speed) return;
			data += peer.speed() * time;
		});

		return Math.min(Math.floor(data / torrent.pieceLength), max);
	};
	var resync = function(offset) {
		var piece = server.position + offset;

		if (!requesting[piece]) return;
		if (server.missing.length < 10) return;

		requesting[piece].forEach(function(peer) {
			if (peer.speed() > 2*BLOCK_SIZE) return;
			if (calcOffset(peer) <= offset) return;
			while (remove(requesting[piece], peer));
			peer.cancel();
			resyncs++;
		});
	};
	var lastResync = 0;
	var resyncAll = function() {
		if (Date.now() - lastResync < 2000) return;
		lastResync = Date.now();
		for (var i = 0; i < 10; i++) {
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
				server.missing.slice(calcOffset(peer)).some(function(piece) {
					if (peer.requests >= MAX_QUEUED) return true;
					if (!peer.peerPieces[piece]) return;

					var offset = server.select(piece, force);
					if (offset === -1) return;

					requesting[piece] = requesting[piece] || [];
					requesting[piece].push(peer);

					peer.request(piece, offset, server.sizeof(piece, offset), function(err, buffer) {
						remove(requesting[piece], peer);
						process.nextTick(update);
						if (err) return server.deselect(piece, offset);
						server.write(piece, offset, buffer);
					});
				});
			};

			select();
			if (!peer.requests && server.missing.length < 30) select(true);
		});
	};

	var onconnection = function(connection, id, address) {
		if (!server.missing.length) return;

		var protocol = wire();

		connection.pipe(protocol).pipe(connection);

		var ontimeout = connection.destroy.bind(connection);
		var timeout = setTimeout(ontimeout, HANDSHAKE_TIMEOUT);

		protocol.once('handshake', function() {
			clearTimeout(timeout);

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
			downloaded += bytes;
			protocol.speed(bytes);
			speed(bytes);
		});

		protocol.on('upload', function(bytes) {
			uploaded += bytes;
		});

		protocol.on('request', function(index, offset, length, callback) {
			server.read(index, offset, length, callback);
		});
	};

	var sw = peerSwarm(torrent.infoHash, {maxSize:MAX_PEERS});
	sw.on('connection', onconnection);
	sw.listen();

	server.listen(8888);
	server.on('error', function() {
		server.listen(0);
	});

	var started = Date.now();
	var active = function(peer) {
		return !peer.peerChoking;
	};

	server.on('listening', function() {
		var href = 'http://'+address()+':'+server.address().port+'/';
		var filename = server.filename.split('/').pop().replace(/\{|\}/g, '');

		if (argv.vlc) proc.exec('vlc '+href+' '+VLC_ARGS+' || /Applications/VLC.app/Contents/MacOS/VLC '+href+' '+VLC_ARGS);
		if (argv.omx) proc.exec(OMX_EXEC+' '+href);
		if (argv.quiet) return console.log('server is listening on '+href);

		var bytes = function(num) {
			return numeral(num).format('0.0b');
		};

		process.stdout.write(new Buffer('G1tIG1sySg==', 'base64')); // clear for drawing
		setInterval(function() {
			var unchoked = peers.filter(active);
			var runtime = Math.floor((Date.now() - started) / 1000);

			clivas.clear();
			clivas.line('{green:open} {bold:vlc} {green:and enter} {bold:'+href+'} {green:as the network addres}');
			clivas.line('');
			clivas.line('{yellow:info} {green:streaming} {bold:'+filename+'} {green:-} {bold:'+bytes(speed())+'/s} {green:from} {bold:'+unchoked.length +'/'+peers.length+'} {green:peers}    ');
			clivas.line('{yellow:info} {green:downloaded} {bold:'+bytes(downloaded)+'} {green:and uploaded }{bold:'+bytes(uploaded)+'} {green:in }{bold:'+runtime+'s} {green:with} {bold:'+resyncs+'} {green:resyncs}     ');
			clivas.line('{yellow:info} {green:found }{bold:'+sw.peersFound+'} {green:peers and} {bold:'+sw.nodesFound+'} {green:nodes through the dht}');
			clivas.line('{yellow:info} {green:peer queue size is} {bold:'+sw.queued+'}     ');
			clivas.line('{yellow:info} {green:target pieces are} {50+bold:'+(server.missing.length ? server.missing.slice(0, 10).join(' ') : '(none)')+'}    ');
			clivas.line('{80:}');

			peers.slice(0, 30).forEach(function(peer) {
				var tags = [];
				if (peer.peerChoking) tags.push('choked');
				if (peer.peerPieces[server.missing[0]]) tags.push('target');
				clivas.line('{25+magenta:'+peer.id+'} {10:↓'+bytes(peer.downloaded)+'} {10+cyan:↓'+bytes(peer.speed())+'/s} {15+grey:'+tags.join(', ')+'}   ');
			});

			if (peers.length > 30) {
				clivas.line('{80:}');
				clivas.line('... and '+(peers.length-30)+' more     ');
			}

			clivas.line('{80:}');
			clivas.flush();
		}, 500);
	});

	process.on('SIGINT', function() {
		if (fs.existsSync(server.destination)) fs.unlinkSync(server.destination);
		process.exit(0);
	});

	require('http').createServer(function(req, res) { // stat server for benchmarking
		res.setHeader('Content-Type', 'application/json');
		res.setHeader('Access-Control-Allow-Origin', '*');
		res.end(JSON.stringify({
			download_speed: Math.round(speed()/1000),
			peers: peers.length,
			active_peers: peers.filter(active).length
		}));
	}).listen(11470).on('error', noop);
});
