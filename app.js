#!/usr/bin/env node

var peerSwarm = require('peer-swarm');
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
var os = require('os');
var createServer = require('./server');

var argv = optimist
	.usage('Usage: $0 torrent_file_or_url [options]')
	.alias('c', 'connections').describe('c', 'max connected peers').default('c', os.cpus().length > 1 ? 100 : 30)
	.alias('p', 'port').describe('p', 'change the http port').default('p', 8888)
	.alias('b', 'buffer').describe('b', 'change buffer file')
	.alias('q', 'quiet').describe('q', 'be quiet')
	.alias('v', 'vlc').describe('v', 'autoplay in vlc*')
	.alias('o', 'omx').describe('o', 'autoplay in omx**')
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
var OMX_EXEC = 'omxplayer -r -o hdmi -t on ';

var CHOKE_TIMEOUT = 5000;
var PIECE_TIMEOUT = 30000;
var HANDSHAKE_TIMEOUT = 5000;
var MIN_SPEED = 8 * 1024; // 8KB/s
var HIGH_QUALITY = 1000 * 1000 * 1000; // we hardcode 1gb files to be HD
var PEER_ID = '-PF0005-'+hat(48);

readTorrent(filename, function(err, torrent) {
	if (err) throw err;

	var selected = biggest(torrent);
	var buffer = path.join(os.tmpDir(), argv.b || torrent.infoHash+'.'+selected.offset);
	var server = createServer(torrent, selected, buffer);
	var peers = [];

	var speed = [0];
	var uploaded = 0;
	var downloaded = 0;
	var requested = 0;
	var lowPriorityOffset = selected.length > HIGH_QUALITY ? 60 : 20;

	var have = bitfield(torrent.pieces.length);

	server.on('readable', function(i) {
		have.set(i);
		peers.forEach(function(peer) {
			peer.have(i);
		});
	});

	var update = function() {
		peers.forEach(function(peer) {
			if (peer.peerChoking) return;

			(peer.downloaded && peer.speed() > MIN_SPEED ? server.missing : server.missing.slice(lowPriorityOffset)).some(function(piece) {
				if (peer.requests && !peer.downloaded) return true;
				if (peer.requests >= MAX_QUEUED)       return true;

				if (!peer.peerPieces[piece]) return;
				var offset = server.select(piece);
				if (offset === -1) return;

				peer.started = peer.started || Date.now();
				peer.request(piece, offset, server.sizeof(piece, offset), function(err) {
					if (err) server.deselect(piece, offset);
				});
			});
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
			protocol.once('finish', function() {
				clearTimeout(timeout);
				peers.splice(peers.indexOf(protocol), 1);
				if (protocol.downloaded) sw.reconnect(address);
			});

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
		protocol.handshake(new Buffer(torrent.infoHash, 'hex'), PEER_ID); // handshake SHOULD accept a hex string as well...
		protocol.bitfield(have);
		protocol.interested();

		protocol.started = 0;
		protocol.speed = function() {
			return 1000 * protocol.downloaded / (Date.now() - protocol.started);
		};

		protocol.setTimeout(PIECE_TIMEOUT, function() {
			if (protocol.requests) protocol.destroy();
		});
		protocol.on('piece', function(index, offset, buffer) {
			speed[0] += buffer.length;
			downloaded += buffer.length;
			server.write(index, offset, buffer);
			update();
		});

		protocol.on('request', function(index, offset, length, callback) {
			requested++;
			server.read(index, offset, length, function(err, buffer) {
				if (err) return callback(err);
				uploaded += length;
				callback(null, buffer);
			});
		});
	};

	var sw = peerSwarm(torrent.infoHash, {maxSize:MAX_PEERS}, onconnection).listen();

	server.listen(8888);
	server.on('error', function() {
		server.listen(0);
	});

	server.on('listening', function() {
		var bytesPerSecond = function() {
			setInterval(function() {
				speed.unshift(speed[0]);
				speed = speed.slice(0, 15);
			}, 1000);

			return function() {
				return numeral((speed[1] - speed[speed.length-1]) / speed.length).format('0.00b')+'/s';
			};
		}();

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
			var unchoked = peers.filter(function(peer) {
				return !peer.peerChoking;
			});

			clivas.clear();
			clivas.line('{green:open} {bold:vlc} {green:and enter} {bold:'+href+'} {green:as the network addres}');
			clivas.line('');
			clivas.line('{yellow:info} {green:streaming} {bold:'+filename+'} {green:-} {bold:'+bytesPerSecond()+'} {green:from} {bold:'+unchoked.length +'/'+peers.length+'} {green:peers}    ');
			clivas.line('{yellow:info} {green:downloaded} {bold:'+bytes(downloaded)+'} {green:and uploaded }{bold:'+bytes(uploaded)+'} {green:from }{bold:'+requested+'}{green: requests}      ');
			clivas.line('{yellow:info} {green:found }{bold:'+sw.peersFound+'} {green:peers and} {bold:'+sw.nodesFound+'} {green:nodes through the dht}');
			clivas.line('{yellow:info} {green:peer queue size is} {bold:'+sw.queued+'}     ');
			clivas.line('{yellow:info} {green:target pieces are} {50+bold:'+(server.missing.length ? server.missing.slice(0, 10).join(' ') : '(none)')+'}    ');
			clivas.line('{80:}');

			peers.slice(0, 30).forEach(function(peer) {
				var tags = [];
				if (peer.peerChoking) tags.push('choked');
				if (peer.peerPieces[server.missing[0]]) tags.push('target');

				clivas.line('{25+magenta:'+peer.id+'} {10:↓'+bytes(peer.downloaded)+'} {10+cyan:↓'+bytes(peer.speed())+'/s} {15+grey:'+tags.join(', ')+'} ');
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
});
