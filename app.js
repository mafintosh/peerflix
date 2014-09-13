#!/usr/bin/env node

var optimist = require('optimist');
var rc = require('rc');
var clivas = require('clivas');
var numeral = require('numeral');
var os = require('os');
var address = require('network-address');
var readTorrent = require('read-torrent');
var proc = require('child_process');
var peerflix = require('./');

var path = require('path');

process.title = 'peerflix';

var argv = rc('peerflix', {}, optimist
	.usage('Usage: $0 magnet-link-or-torrent [options]')
	.alias('c', 'connections').describe('c', 'max connected peers').default('c', os.cpus().length > 1 ? 100 : 30)
	.alias('p', 'port').describe('p', 'change the http port').default('p', 8888)
	.alias('i', 'index').describe('i', 'changed streamed file (index)')
	.alias('l', 'list').describe('l', 'list available files with corresponding index')
	.alias('t', 'subtitles').describe('t', 'load subtitles file')
	.alias('q', 'quiet').describe('q', 'be quiet')
	.alias('v', 'vlc').describe('v', 'autoplay in vlc*')
	.alias('s', 'airplay').describe('s', 'autoplay via AirPlay')
	.alias('m', 'mplayer').describe('m', 'autoplay in mplayer*')
	.alias('k', 'mpv').describe('k', 'autoplay in mpv*')
	.alias('o', 'omx').describe('o', 'autoplay in omx**')
	.alias('j', 'jack').describe('j', 'autoplay in omx** using the audio jack')
	.alias('f', 'path').describe('f', 'change buffer file path')
	.alias('b', 'blocklist').describe('b', 'use the specified blocklist')
	.alias('n', 'no-quit').describe('n', 'do not quit peerflix on vlc exit')
	.alias('a', 'all').describe('a', 'select all files in the torrent')
	.alias('r', 'remove').describe('r', 'remove files on exit')
	.alias('e', 'peer').describe('e', 'add peer by ip:port')
	.alias('x', 'peer-port').describe('x', 'set peer listening port')
	.alias('d', 'not-on-top').describe('d', 'do not float video on top')
	.describe('version', 'prints current version')
	.argv);

if (argv.version) {
	console.error(require('./package').version);
	process.exit(0);
}

var filename = argv._[0];
var onTop = !argv.d

if (!filename) {
	optimist.showHelp();
	console.error('* Autoplay can take several seconds to start since it needs to wait for the first piece');
	console.error('** OMX player is the default Raspbian video player\n');
	process.exit(1);
}

var VLC_ARGS = '-q '+(onTop ? '--video-on-top' : '')+' --play-and-exit';
var OMX_EXEC = argv.jack ? 'omxplayer -r -o local ' : 'omxplayer -r -o hdmi ';
var MPLAYER_EXEC = 'mplayer '+(onTop ? '-ontop' : '')+' -really-quiet -noidx -loop 0 ';
var MPV_EXEC = 'mpv '+(onTop ? '--ontop' : '')+' --really-quiet --loop=no ';

if (argv.t) {
	VLC_ARGS += ' --sub-file=' + argv.t;
	OMX_EXEC += ' --subtitles ' + argv.t;
	MPLAYER_EXEC += ' -sub ' + argv.t;
	MPV_EXEC += ' --sub-file=' + argv.t;
}

var noop = function() {};

var ontorrent = function(torrent) {
	if (argv['peer-port']) argv.peerPort = Number(argv['peer-port'])

	var engine = peerflix(torrent, argv);
	var hotswaps = 0;
	var verified = 0;
	var invalid = 0;

	engine.on('verify', function() {
		verified++;
	});

	engine.on('invalid-piece', function() {
		invalid++;
	});


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
	var wires = engine.swarm.wires;
	var swarm = engine.swarm;

	var active = function(wire) {
		return !wire.peerChoking;
	};
	
	[].concat(argv.peer || []).forEach(function(peer) {
		engine.connect(peer);
	})

	engine.server.on('listening', function() {
		var href = 'http://'+address()+':'+engine.server.address().port+'/';
		var filename = engine.server.index.name.split('/').pop().replace(/\{|\}/g, '');
		var filelength = engine.server.index.length;

		if (argv.all) {
			filename = engine.torrent.name;
			filelength = engine.torrent.length;
			href += '.m3u';
		}

		if (argv.vlc && process.platform === 'win32') {
			var registry = require('windows-no-runnable').registry;
			var key;
			if (process.arch === 'x64') {
				try {
					key = registry('HKLM/Software/Wow6432Node/VideoLAN/VLC');
				} catch (e) {
					try {
						key = registry('HKLM/Software/VideoLAN/VLC');
					} catch (err) {}
				}
			} else {
				try {
					key = registry('HKLM/Software/VideoLAN/VLC');
				} catch (err) {
					try {
						key = registry('HKLM/Software/Wow6432Node/VideoLAN/VLC');
					} catch (e) {}
				}
			}

			if (key) {
				var vlcPath = key['InstallDir'].value + path.sep + 'vlc';
				VLC_ARGS = VLC_ARGS.split(' ');
				VLC_ARGS.unshift(href);
				proc.execFile(vlcPath, VLC_ARGS);
			}
		} else {
			if (argv.vlc) {
				var root = '/Applications/VLC.app/Contents/MacOS/VLC'
				var home = (process.env.HOME || '') + root
				var vlc = proc.exec('vlc '+href+' '+VLC_ARGS+' || '+root+' '+href+' '+VLC_ARGS+' || '+home+' '+href+' '+VLC_ARGS, function(error, stdout, stderror){
					if (error) {
						process.exit(0);
					}
				});

				vlc.on('exit', function(){
					if (!argv.n && argv.quit !== false) process.exit(0);
				});
			}
		}

		if (argv.omx) proc.exec(OMX_EXEC+' '+href);
		if (argv.mplayer) proc.exec(MPLAYER_EXEC+' '+href);
		if (argv.mpv) proc.exec(MPV_EXEC+' '+href);
		if (argv.airplay) {
			var browser = require('airplay-js').createBrowser();
			browser.on('deviceOn', function( device ) {
				device.play(href, 0, noop);
			});
			browser.start();
		}

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
		  if (argv.airplay) clivas.line('{green:Streaming to} {bold:AppleTV} {green:using Airplay}');
			clivas.line('');
			clivas.line('{yellow:info} {green:streaming} {bold:'+filename+' ('+bytes(filelength)+')} {green:-} {bold:'+bytes(swarm.downloadSpeed())+'/s} {green:from} {bold:'+unchoked.length +'/'+wires.length+'} {green:peers}    ');
			clivas.line('{yellow:info} {green:path} {cyan:' + engine.path + '}');
			clivas.line('{yellow:info} {green:downloaded} {bold:'+bytes(swarm.downloaded)+'} {green:and uploaded }{bold:'+bytes(swarm.uploaded)+'} {green:in }{bold:'+runtime+'s} {green:with} {bold:'+hotswaps+'} {green:hotswaps}     ');
			clivas.line('{yellow:info} {green:verified} {bold:'+verified+'} {green:pieces and received} {bold:'+invalid+'} {green:invalid pieces}');
			clivas.line('{yellow:info} {green:peer queue size is} {bold:'+swarm.queued+'}');
			clivas.line('{80:}');
			linesremaining -= 8;

			wires.every(function(wire) {
				var tags = [];
				if (wire.peerChoking) tags.push('choked');
				clivas.line('{25+magenta:'+wire.peerAddress+'} {10:'+bytes(wire.downloaded)+'} {10+cyan:'+bytes(wire.downloadSpeed())+'/s} {15+grey:'+tags.join(', ')+'}   ');
				peerslisted++;
				return linesremaining-peerslisted > 4;
			});
			linesremaining -= peerslisted;

			if (wires.length > peerslisted) {
				clivas.line('{80:}');
				clivas.line('... and '+(wires.length-peerslisted)+' more     ');
			}

			clivas.line('{80:}');
			clivas.flush();
		};

		setInterval(draw, 500);
		draw();
	});

	engine.server.once('error', function() {
		engine.server.listen(0);
	});

	var onmagnet = function() {
		clivas.clear();
		clivas.line('{green:fetching torrent metadata from} {bold:'+engine.swarm.wires.length+'} {green:peers}');
	};

	if (typeof torrent === 'string' && torrent.indexOf('magnet:') === 0 && !argv.quiet) {
		onmagnet();
		engine.swarm.on('wire', onmagnet);
	}

	engine.on('ready', function() {
		engine.swarm.removeListener('wire', onmagnet);
		if (!argv.all) return;
		engine.files.forEach(function(file) {
			file.select();
		});
	});

	if(argv.remove) {
		var remove = function() {
			engine.remove(function() {
				process.exit();
			});
		};

		process.on('SIGINT', remove);
		process.on('SIGTERM', remove);
	}
};

if (/^magnet:/.test(filename)) return ontorrent(filename);

readTorrent(filename, function(err, torrent) {
	if (err) {
		console.error(err.message);
		process.exit(1);
	}

	ontorrent(torrent);
});
