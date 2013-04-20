#!/usr/bin/env node

var optimist = require('optimist');
var clivas = require('clivas');
var numeral = require('numeral');
var os = require('os');
var address = require('network-address');
var proc = require('child_process');
var peerflix = require('./');

var argv = optimist
	.usage('Usage: $0 torrent_file_or_url [options]')
	.alias('c', 'connections').describe('c', 'max connected peers').default('c', os.cpus().length > 1 ? 100 : 30)
	.alias('p', 'port').describe('p', 'change the http port').default('p', 8888)
	.alias('b', 'buffer').describe('b', 'change buffer size').default('b', '1.5MB')
	.alias('bp', 'path').describe('bp', 'change buffer file path')
	.alias('i', 'index').describe('i', 'changed streamed file (index)')
	.alias('q', 'quiet').describe('q', 'be quiet')
	.alias('s', 'stat').describe('s', 'export a statistics server on port 11470')
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

var VLC_ARGS = '-q --video-on-top --play-and-exit';
var OMX_EXEC = argv.jack ? 'omxplayer -r -o local ' : 'omxplayer -r -o hdmi ';

peerflix(filename, argv, function(pf)
{
	var peers = pf.peers,
		server = pf.server,
		speed = pf.speed,
		sw = pf.swarm;
			
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
			clivas.line('{yellow:info} {green:downloaded} {bold:'+bytes(pf.downloaded)+'} {green:and uploaded }{bold:'+bytes(pf.uploaded)+'} {green:in }{bold:'+runtime+'s} {green:with} {bold:'+pf.resyncs+'} {green:resyncs}     ');
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
		pf.clearCache();
		process.exit(0);
	});

	if (! argv.stats)
		return;
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

