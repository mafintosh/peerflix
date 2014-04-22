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
	.usage('Usage: $0 magnet-link-or-torrent [options]')
	.alias('c', 'connections').describe('c', 'max connected peers').default('c', os.cpus().length > 1 ? 100 : 30)
	.alias('p', 'port').describe('p', 'change the http port').default('p', 8888)
	.alias('i', 'index').describe('i', 'changed streamed file (index)')
	.alias('l', 'list').describe('l', 'list available files with corresponding index')
	.alias('t', 'subtitles').describe('t', 'load subtitles file')
	.alias('q', 'quiet').describe('q', 'be quiet')
	.alias('v', 'vlc').describe('v', 'autoplay in vlc*')
	.alias('m', 'mplayer').describe('m', 'autoplay in mplayer*')
	.alias('o', 'omx').describe('o', 'autoplay in omx**')
	.alias('j', 'jack').describe('j', 'autoplay in omx** using the audio jack')
	.alias('f', 'path').describe('f', 'change buffer file path')
	.alias('b', 'blocklist').describe('b', 'use the specified blocklist')
	.describe('version', 'prints current version')
	.argv;

if (argv.version) {
	console.error(require('./package').version);
	process.exit(0);
}

var filename = argv._[0];

if (!filename) {
	optimist.showHelp();
	console.error('* Autoplay can take several seconds to start since it needs to wait for the first piece');
	console.error('** OMX player is the default Raspbian video player\n');
	process.exit(1);
}

var VLC_ARGS = '-q --video-on-top --play-and-exit';
var OMX_EXEC = argv.jack ? 'omxplayer -r -o local ' : 'omxplayer -r -o hdmi ';
var MPLAYER_EXEC = 'mplayer -ontop -really-quiet -noidx -loop 0 ';

if (argv.t) {
	VLC_ARGS += ' --sub-file=' + argv.t;
	OMX_EXEC += ' --subtitles ' + argv.t;
	MPLAYER_EXEC += ' -sub ' + argv.t;
}

var engine = peerflix(filename, argv);

engine.on('error', function(err) {
	console.error(err);
	process.exit(1);
})

// Display Loading metadata..
engine.on('init', function() {
	var loading = function() {
		clivas.clear();
		clivas.line('{green:fetching torrent metadata from} {bold:'+engine.swarm.wires.length+'} {green:peers}');
	};
	loading();
	engine.swarm.on('wire', loading);
	engine.on('torrent-metadata', function() {
		engine.swarm.removeListener('wire', loading)
	});
});


var hotswaps = 0;

if (argv.list) {
	var onready = function() {
		engine.files.forEach(function(file, i, files) {
			clivas.line('{3+bold:'+i+'} : {magenta:'+file.name+'}');
		});
		process.exit(0);
	};
	if (engine.torrent) onready();
	else engine.on('ready', onready);
	return;
}

engine.on('hotswap', function() {
	hotswaps++;
});

var started = Date.now();

var active = function(wire) {
	return !wire.peerChoking;
};

engine.server.on('listening', function() {
	var href = 'http://'+address()+':'+engine.server.address().port+'/';
	var filename = engine.server.index.name.split('/').pop().replace(/\{|\}/g, '');

	if (argv.vlc && process.platform === 'win32') {
		var registry = require('windows-no-runnable').registry;
		var key;
		if (process.arch === 'x64') {
			try {
				key = registry('HKLM/Software/Wow6432Node/VideoLAN/VLC');
			} catch (e) {}
		} else {
			try {
				key = registry('HKLM/Software/VideoLAN/VLC');
			} catch (err) {}
		}

		if (key) {
			var vlcPath = key['InstallDir'].value + path.sep + 'vlc';
			VLC_ARGS = VLC_ARGS.split(' ');
			VLC_ARGS.unshift(href);
			proc.execFile(vlcPath, VLC_ARGS);
		}
	} else {
		if (argv.vlc) {
			var vlc = proc.exec('vlc '+href+' '+VLC_ARGS+' || /Applications/VLC.app/Contents/MacOS/VLC '+href+' '+VLC_ARGS, function(error, stdout, stderror){
				if (error) {
					process.exit(0);
				}
			});

			vlc.on('exit', function(){
				process.exit(0);
			});
		}
	}

	if (argv.omx) proc.exec(OMX_EXEC+' '+href);
	if (argv.mplayer) proc.exec(MPLAYER_EXEC+' '+href);
	if (argv.quiet) return console.log('server is listening on '+href);

	var bytes = function(num) {
		return numeral(num).format('0.0b');
	};

	process.stdout.write(new Buffer('G1tIG1sySg==', 'base64')); // clear for drawing

	var draw = function() {
		var unchoked = engine.swarm.wires.filter(active);
		var runtime = Math.floor((Date.now() - started) / 1000);
		var linesremaining = clivas.height;
		var peerslisted = 0;

		clivas.clear();
		clivas.line('{green:open} {bold:vlc} {green:and enter} {bold:'+href+'} {green:as the network address}');
		clivas.line('');
		clivas.line('{yellow:info} {green:streaming} {bold:'+filename+'} {green:-} {bold:'+bytes(engine.swarm.downloadSpeed())+'/s} {green:from} {bold:'+unchoked.length +'/'+engine.swarm.wires.length+'} {green:peers}    ');
		clivas.line('{yellow:info} {green:downloaded} {bold:'+bytes(engine.swarm.downloaded)+'} {green:and uploaded }{bold:'+bytes(engine.swarm.uploaded)+'} {green:in }{bold:'+runtime+'s} {green:with} {bold:'+hotswaps+'} {green:hotswaps}     ');
		clivas.line('{yellow:info} {green:peer queue size is} {bold:'+engine.swarm.queued+'}     ');
		clivas.line('{80:}');
		linesremaining -= 8;

		engine.swarm.wires.every(function(wire) {
			var tags = [];
			if (wire.peerChoking) tags.push('choked');
			clivas.line('{25+magenta:'+wire.peerAddress+'} {10:'+bytes(wire.downloaded)+'} {10+cyan:'+bytes(wire.downloadSpeed())+'/s} {15+grey:'+tags.join(', ')+'}   ');
			peerslisted++;
			return linesremaining-peerslisted > 4;
		});
		linesremaining -= peerslisted;

		if (engine.swarm.wires.length > peerslisted) {
			clivas.line('{80:}');
			clivas.line('... and '+(engine.swarm.wires.length-peerslisted)+' more     ');
		}

		clivas.line('{80:}');
		clivas.flush();
	};

	setInterval(draw, 500);
	draw();
});

// Retry with different port
engine.server.once('error', function() {
	engine.server.listen(0);
});
