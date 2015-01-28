#!/usr/bin/env node

var optimist = require('optimist')
var rc = require('rc')
var clivas = require('clivas')
var numeral = require('numeral')
var os = require('os')
var address = require('network-address')
var readTorrent = require('read-torrent')
var proc = require('child_process')
var Peerflix = require('./')
var keypress = require('keypress')
var open = require('open')

var path = require('path')

process.title = 'peerflix'

var argv = rc('peerflix', {}, optimist
  .usage('Usage: $0 magnet-link-or-torrent [options]')
  .alias('c', 'connections').describe('c', 'max connected peers').default('c', os.cpus().length > 1 ? 100 : 30)
  .alias('p', 'port').describe('p', 'change the http port').default('p', 8888)
  .alias('i', 'index').describe('i', 'changed streamed file (index)')
  .alias('l', 'list').describe('l', 'list available files with corresponding index').boolean('l')
  .alias('t', 'subtitles').describe('t', 'load subtitles file')
  .alias('q', 'quiet').describe('q', 'be quiet').boolean('v')
  .alias('v', 'vlc').describe('v', 'autoplay in vlc*').boolean('v')
  .alias('s', 'airplay').describe('s', 'autoplay via AirPlay').boolean('a')
  .alias('m', 'mplayer').describe('m', 'autoplay in mplayer*').boolean('m')
  .alias('g', 'smplayer').describe('g', 'autoplay in smplayer*').boolean('g')
  .describe('mpchc', 'autoplay in MPC-HC player*').boolean('boolean')
  .alias('k', 'mpv').describe('k', 'autoplay in mpv*').boolean('k')
  .alias('o', 'omx').describe('o', 'autoplay in omx**').boolean('o')
  .alias('w', 'webplay').describe('w', 'autoplay in webplay').boolean('w')
  .alias('j', 'jack').describe('j', 'autoplay in omx** using the audio jack').boolean('j')
  .alias('f', 'path').describe('f', 'change buffer file path')
  .alias('b', 'blocklist').describe('b', 'use the specified blocklist')
  .alias('n', 'no-quit').describe('n', 'do not quit peerflix on vlc exit').boolean('n')
  .alias('a', 'all').describe('a', 'select all files in the torrent').boolean('a')
  .alias('r', 'remove').describe('r', 'remove files on exit').boolean('r')
  .alias('h', 'hostname').describe('h', 'host name or IP to bind the server to')
  .alias('e', 'peer').describe('e', 'add peer by ip:port')
  .alias('x', 'peer-port').describe('x', 'set peer listening port')
  .alias('d', 'not-on-top').describe('d', 'do not float video on top').boolean('d')
  .describe('on-downloaded', 'script to call when file is 100% downloaded')
  .describe('on-listening', 'script to call when server goes live')
  .describe('version', 'prints current version').boolean('boolean')
  .argv)

if (argv.version) {
  console.error(require('./package').version)
  process.exit(0)
}

var filename = argv._[0]
var onTop = !argv.d

if (!filename) {
  optimist.showHelp()
  console.error('Options passed after -- will be passed to your player')
  console.error('')
  console.error('  "peerflix magnet-link --vlc -- --fullscreen" will pass --fullscreen to vlc')
  console.error('')
  console.error('* Autoplay can take several seconds to start since it needs to wait for the first piece')
  console.error('** OMX player is the default Raspbian video player\n')
  process.exit(1)
}

var VLC_ARGS = '-q '+(onTop ? '--video-on-top' : '')+' --play-and-exit'
var OMX_EXEC = argv.jack ? 'omxplayer -r -o local ' : 'omxplayer -r -o hdmi '
var MPLAYER_EXEC = 'mplayer '+(onTop ? '-ontop' : '')+' -really-quiet -noidx -loop 0 '
var SMPLAYER_EXEC = 'smplayer '+(onTop ? '-ontop' : '')
var MPV_EXEC = 'mpv '+(onTop ? '--ontop' : '')+' --really-quiet --loop=no '
var MPC_HC_ARGS = '/play'

if (argv.t) {
  VLC_ARGS += ' --sub-file=' + argv.t
  OMX_EXEC += ' --subtitles ' + argv.t
  MPLAYER_EXEC += ' -sub ' + argv.t
  SMPLAYER_EXEC += ' -sub ' + argv.t
  MPV_EXEC += ' --sub-file=' + argv.t
}

if (argv._.length > 1) {
  var _args = argv._
  _args.shift()
  var playerArgs = _args.join(' ')
  VLC_ARGS += ' ' + playerArgs
  OMX_EXEC += ' ' + playerArgs
  MPLAYER_EXEC += ' ' + playerArgs
  SMPLAYER_EXEC += ' ' + playerArgs
  MPV_EXEC += ' ' + playerArgs
  MPC_HC_ARGS += ' ' + playerArgs
}

var noop = function() {}

var exec = function(argv, localHref, href) {
	var player = null;

	if (argv.vlc && process.platform === 'win32') {
		player = 'vlc'
		var registry = require('windows-no-runnable').registry
		var key
		if (process.arch === 'x64') {
			try {
				key = registry('HKLM/Software/Wow6432Node/VideoLAN/VLC')
			} catch (e) {
				try {
					key = registry('HKLM/Software/VideoLAN/VLC')
				} catch (err) {}
			}
		} else {
			try {
				key = registry('HKLM/Software/VideoLAN/VLC')
			} catch (err) {
				try {
					key = registry('HKLM/Software/Wow6432Node/VideoLAN/VLC')
				} catch (e) {}
			}
		}

		if (key) {
			var vlcPath = key['InstallDir'].value + path.sep + 'vlc'
			VLC_ARGS = VLC_ARGS.split(' ')
			VLC_ARGS.unshift(localHref)
			proc.execFile(vlcPath, VLC_ARGS)
		}
	} else if (argv.mpchc && process.platform === 'win32') {
		player = 'mph-hc'
		var registry = require('windows-no-runnable').registry
		var key = registry('HKCU/Software/MPC-HC/MPC-HC')

		var exePath = key['ExePath']
		proc.exec('"' + exePath + '" "' + localHref + '" ' + MPC_HC_ARGS)
	} else {
		if (argv.vlc) {
			player = 'vlc'
			var root = '/Applications/VLC.app/Contents/MacOS/VLC'
			var home = (process.env.HOME || '') + root
			var vlc = proc.exec('vlc '+VLC_ARGS+' '+localHref+' || '+root+' '+VLC_ARGS+' '+localHref+' || '+home+' '+VLC_ARGS+' '+localHref, function(error, stdout, stderror){
				if (error) {
					process.exit(0)
				}
			})

			vlc.on('exit', function(){
				if (!argv.n && argv.quit !== false) process.exit(0)
			})
		}
	}

	if (argv.omx) {
		player = 'omx'
		proc.exec(OMX_EXEC+' '+localHref)
	}
	if (argv.mplayer) {
		player = 'mplayer'
		proc.exec(MPLAYER_EXEC+' '+localHref)
	}
	if (argv.smplayer) {
		player = 'smplayer'
		proc.exec(SMPLAYER_EXEC+' '+localHref)
	}
	if (argv.mpv) {
		player = 'mpv'
		proc.exec(MPV_EXEC+' '+localHref)
	}
	if (argv.webplay) {
		player = 'webplay'
		open('https://85d514b3e548d934d8ff7c45a54732e65a3162fe.htmlb.in/#'+localHref)
	}
	if (argv.airplay) {
		var browser = require('airplay-js').createBrowser()
		browser.on('deviceOn', function( device ) {
			device.play(href, 0, noop)
		})
		browser.start()
	}

	if (argv['on-listening']) proc.exec(argv['on-listening']+' '+href)

	if (argv.quiet) return console.log('server is listening on '+href)

	return player;
}

new Peerflix(filename, argv);
