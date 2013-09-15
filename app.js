#!/usr/bin/env node

var optimist = require('optimist');
var clivas = require('clivas');
var numeral = require('numeral');
var os = require('os');
var address = require('network-address');
var proc = require('child_process');
var peerflix = require('./');

var path = require('path');

var argv = optimist
	.usage('Usage: $0 torrent_file_or_url [options]')
	.alias('c', 'connections').describe('c', 'max connected peers').default('c', os.cpus().length > 1 ? 100 : 30)
	.alias('p', 'port').describe('p', 'change the http port').default('p', 8888)
	.alias('b', 'buffer').describe('b', 'change buffer size').default('b', '1.5MB')
	.alias('i', 'index').describe('i', 'changed streamed file (index)')
	.alias('t', 'subtitles').describe('t', 'load subtitles file')
	.alias('f', 'fastpeers').describe('f', 'a comma-separated list of addresses of known fast peers')
	.alias('q', 'quiet').describe('q', 'be quiet')
	.alias('s', 'stats').describe('s', 'export a statistics server on port 11470')
	.alias('v', 'vlc').describe('v', 'autoplay in vlc*')
	.alias('m', 'mplayer').describe('m', 'autoplay in mplayer**')
	.alias('o', 'omx').describe('o', 'autoplay in omx**')
	.alias('j', 'jack').describe('j', 'autoplay in omx** using the audio jack')
	.describe('path', 'change buffer file path')
	.argv;

var filename = argv._[0];

if (!filename) {
	optimist.showHelp();
	console.error('*Autoplay can take several seconds to start since it needs to wait for the first piece');
	console.error('*OMX player is the default Raspbian video player\n');
	process.exit(1);
}

var VLC_ARGS = '-q --video-on-top --play-and-exit';
var OMX_EXEC = argv.jack ? 'omxplayer -r -o local ' : 'omxplayer -r -o hdmi ';
var MPLAYER_EXEC = 'mplayer -ontop -really-quiet -noidx -loop 0 ';
if (argv.t)	{
	VLC_ARGS += ' --sub-file=' + argv.t
	OMX_EXEC += ' --subtitles ' + argv.t
	MPLAYER_EXEC += ' −sub ' + argv.t
}

var noop = function() {};

peerflix(filename, argv, function(err, flix) {
	if (err) throw err;

	var peers = flix.peers;
	var server = flix.server;
	var storage = flix.storage;
	var speed = flix.speed;
	var sw = flix.swarm;

	var started = Date.now();
	var active = function(peer) {
		return !peer.peerChoking;
	};

	server.on('listening', function() {
		var href = 'http://'+address()+':'+server.address().port+'/';
		var filename = storage.filename.split('/').pop().replace(/\{|\}/g, '');

		if (argv.vlc) proc.exec('vlc '+href+' '+VLC_ARGS+' || /Applications/VLC.app/Contents/MacOS/VLC '+href+' '+VLC_ARGS);
		if (argv.omx) proc.exec(OMX_EXEC+' '+href);
		if (argv.mplayer) proc.exec(MPLAYER_EXEC+' '+href);
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
			clivas.line('{yellow:info} {green:downloaded} {bold:'+bytes(flix.downloaded)+'} {green:and uploaded }{bold:'+bytes(flix.uploaded)+'} {green:in }{bold:'+runtime+'s} {green:with} {bold:'+flix.resyncs+'} {green:resyncs}     ');
			clivas.line('{yellow:info} {green:found }{bold:'+sw.peersFound+'} {green:peers and} {bold:'+sw.nodesFound+'} {green:nodes through the dht}');
			clivas.line('{yellow:info} {green:peer queue size is} {bold:'+sw.queued+'}     ');
			clivas.line('{yellow:info} {green:target pieces are} {50+bold:'+(storage.missing.length ? storage.missing.slice(0, 10).join(' ') : '(none)')+'}    ');
			clivas.line('{80:}');

			peers.slice(0, 30).forEach(function(peer) {
				var tags = [];
				if (peer.peerChoking) tags.push('choked');
				if (peer.peerPieces[storage.missing[0]]) tags.push('target');
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
	//	flix.clearCache();
		process.exit(0);
	});

	if (!argv.stats) return;

	require('http').createServer(function(req, res) { // stat server for benchmarking
		res.setHeader('Content-Type', 'application/json');
		res.setHeader('Access-Control-Allow-Origin', '*');

		// Torrent file
		var origin = flix.selected;

		// File on disk
		var dest = storage.dest;

		// Chunks and progress
		var totalChunks = dest.parts.length;
		var currentChunks = dest.verifiedParts;
		var missingChunks = totalChunks - currentChunks;

		var chunks = {
			total: totalChunks,
			current: currentChunks,
			missing: missingChunks
		};
		var progress = chunks.current / chunks.total;

		res.end(JSON.stringify({
			// Current progress
			progress: progress,

			// Is it completed
			complete: dest.complete(),

			// Chunks
			chunks: chunks,

			// Filenames
			name: origin.name,
			path: path.resolve(dest.filename),

			// Speed in kb/s
			download_speed: Math.round(speed()/1000),

			// Torrent stuff
			peers: peers.length,
			active_peers: peers.filter(active).length
		}));
	}).listen(11470).on('error', noop);
});
