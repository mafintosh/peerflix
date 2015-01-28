var torrentStream = require('torrent-stream')
var http = require('http')
var fs = require('fs')
var rangeParser = require('range-parser')
var xtend = require('xtend')
var url = require('url')
var mime = require('mime')
var pump = require('pump')

var clivas = require('clivas')
var numeral = require('numeral')
var os = require('os')
var address = require('network-address')
var readTorrent = require('read-torrent')
var proc = require('child_process')
var keypress = require('keypress')
var open = require('open')

var path = require('path')


/**
 * @param {string} torrent
 * @constructor
 */
var Peerflix = function(torrent, argv) {
	this._argv = argv
	if (/^magnet:/.test(torrent)) {
		this.ontorrent(torrent)
	}

	// TODO: don't use read-torrent anymore as we don't really use the parsing part of it...
	readTorrent(torrent, function(err, torrent, raw) {
		if (err) {
			console.error(err.message)
			process.exit(1)
		}

		this.ontorrent(raw) // use raw so we don't get infohash/metadata issues in torrent-stream.
	}.bind(this))


};


Peerflix.prototype.parseBlocklist = function(filename) {
	// TODO: support gzipped files
	var blocklistData = fs.readFileSync(filename, { encoding: 'utf8' })
	var blocklist = []
	blocklistData.split('\n').forEach(function(line) {
		var match = null
		if ((match = /^\s*[^#].*?\s*:\s*([a-f0-9.:]+?)\s*-\s*([a-f0-9.:]+?)\s*$/.exec(line))) {
			blocklist.push({
				start: match[1],
				end: match[2]
			})
		}
	})
	return blocklist
}


Peerflix.prototype.truthy = function() {
	return true
}


Peerflix.prototype.createServer = function(e, opts) {
	var server = http.createServer()
	var index = opts.index
	var getType = opts.type || mime.lookup.bind(mime)
	var filter = opts.filter || this.truthy

	var onready = function() {
		if (typeof index !== 'number') {
			index = e.files.reduce(function(a, b) {
				return a.length > b.length ? a : b
			})
			index = e.files.indexOf(index)
		}

		e.files[index].select()
		server.index = e.files[index]

		if (opts.sort) e.files.sort(opts.sort)
	}

	if (e.torrent) onready()
	else e.on('ready', onready)

	server.on('request', function(request, response) {
		var u = url.parse(request.url)
		var host = request.headers.host || 'localhost'

		var toPlaylist = function() {
			var toEntry = function(file, i) {
				return '#EXTINF:-1,' + file.path + '\n' + 'http://' + host + '/' + i
			}

			return '#EXTM3U\n' + e.files.filter(filter).map(toEntry).join('\n')
		}

		var toJSON = function() {
			var toEntry = function(file, i) {
				return {name:file.name, length:file.length, url:'http://'+host+'/'+i}
			}

			return JSON.stringify(e.files.filter(filter).map(toEntry), null, '	')
		}

		// Allow CORS requests to specify arbitrary headers, e.g. 'Range',
		// by responding to the OPTIONS preflight request with the specified
		// origin and requested headers.
		if (request.method === 'OPTIONS' && request.headers['access-control-request-headers']) {
			response.setHeader('Access-Control-Allow-Origin', request.headers.origin)
			response.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
			response.setHeader(
					'Access-Control-Allow-Headers',
					request.headers['access-control-request-headers'])
			response.setHeader('Access-Control-Max-Age', '1728000')

			response.end()
			return
		}

		if (request.headers.origin) response.setHeader('Access-Control-Allow-Origin', request.headers.origin)
		if (u.pathname === '/') u.pathname = '/'+index

		if (u.pathname === '/favicon.ico') {
			response.statusCode = 404
			response.end()
			return
		}

		if (u.pathname === '/.json') {
			var json = toJSON()
			response.setHeader('Content-Type', 'application/json; charset=utf-8')
			response.setHeader('Content-Length', Buffer.byteLength(json))
			response.end(json)
			return
		}

		if (u.pathname === '/.m3u') {
			var playlist = toPlaylist()
			response.setHeader('Content-Type', 'application/x-mpegurl; charset=utf-8')
			response.setHeader('Content-Length', Buffer.byteLength(playlist))
			response.end(playlist)
			return
		}

		e.files.forEach(function(file, i) {
			if (u.pathname.slice(1) === file.name) u.pathname = '/'+i
		})

		var i = Number(u.pathname.slice(1))

		if (isNaN(i) || i >= e.files.length) {
			response.statusCode = 404
			response.end()
			return
		}

		var file = e.files[i]
		var range = request.headers.range
		range = range && rangeParser(file.length, range)[0]
		response.setHeader('Accept-Ranges', 'bytes')
		response.setHeader('Content-Type', getType(file.name))
		response.setHeader('transferMode.dlna.org', 'Streaming')
		response.setHeader('contentFeatures.dlna.org', 'DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=017000 00000000000000000000000000')
		if (!range) {
			response.setHeader('Content-Length', file.length)
			if (request.method === 'HEAD') return response.end()
			pump(file.createReadStream(), response)
			return
		}

		response.statusCode = 206
		response.setHeader('Content-Length', range.end - range.start + 1)
		response.setHeader('Content-Range', 'bytes '+range.start+'-'+range.end+'/'+file.length)
		response.setHeader('transferMode.dlna.org', 'Streaming')
		response.setHeader('contentFeatures.dlna.org', 'DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=017000 00000000000000000000000000')
		if (request.method === 'HEAD') return response.end()
		pump(file.createReadStream(range), response)
	})

	server.on('connection', function(socket) {
		socket.setTimeout(36000000)
	})

	return server
}




Peerflix.prototype.ontorrent = function(torrent, exec) {
	if (this._argv['peer-port']) this._argv.peerPort = Number(this._argv['peer-port'])

	this._torrentStreamEngine = this.start(torrent)
	var hotswaps = 0
	var verified = 0
	var invalid = 0

	this._torrentStreamEngine.on('verify', function() {
		verified++
	})

	this._torrentStreamEngine.on('invalid-piece', function() {
		invalid++
	})



	if (this._argv.list) {
		var onready = function() {
			this._torrentStreamEngine.files.forEach(function(file, i, files) {
				clivas.line('{3+bold:'+i+'} : {magenta:'+file.name+'} : {blue:'+this._bytes(file.length)+'}')
			}, this)
			process.exit(0)
		}.bind(this)
		if (this._torrentStreamEngine.torrent) onready()
		else this._torrentStreamEngine.on('ready', onready)
		return
	}

	this._torrentStreamEngine.on('hotswap', function() {
		hotswaps++
	})

	this._started = Date.now()

	var peers = [].concat(this._argv.peer || [])
	peers.forEach(function(peer) {
		this._torrentStreamEngine.connect(peer)
	}, this)

	if (this._argv['on-downloaded']){
		var downloaded = false
		this._torrentStreamEngine.on('uninterested', function() {
			if(!downloaded) proc.exec(this._argv['on-downloaded'])
			downloaded = true
		}.bind(this))
	}

	this._torrentStreamEngine.server.on('listening', this._handler.bind(this, exec))

	this._torrentStreamEngine.server.once('error', this._torrentStreamEngine.server.listen.bind(this._torrentStreamEngine.server, 0, this._argv.hostname))

	var onmagnet = function() {
		clivas.clear()
		clivas.line('{green:fetching torrent metadata from} {bold:'+this._torrentStreamEngine.swarm.wires.length+'} {green:peers}')
	}.bind(this)

	if (typeof torrent === 'string' && torrent.indexOf('magnet:') === 0 && !this._argv.quiet) {
		onmagnet()
		this._torrentStreamEngine.swarm.on('wire', onmagnet)
	}

	this._torrentStreamEngine.on('ready', function() {
		this._torrentStreamEngine.swarm.removeListener('wire', onmagnet)
		if (!this._argv.all) return
		this._torrentStreamEngine.files.forEach(function(file) {
			file.select()
		})
	}.bind(this))

	var onexit = function() {
		// we're doing some heavy lifting so it can take some time to exit... let's
		// better output a status message so the user knows we're working on it :)
		clivas.line('')
		clivas.line('{yellow:info} {green:peerflix is exiting...}')
	}

	if (this._argv.remove) {
		var remove = function() {
			onexit()
			this._torrentStreamEngine.remove(function() {
				process.exit()
			})
		}.bind(this)

		process.on('SIGINT', remove)
		process.on('SIGTERM', remove)
	} else {
		process.on('SIGINT', function() {
			onexit()
			process.exit()
		})
	}
}


Peerflix.prototype.start = function(torrent, opts) {
	if (!opts) opts = {}

	// Parse blocklist
	if (opts.blocklist) opts.blocklist = this.parseBlocklist(opts.blocklist)
	this._torrentStreamEngine = torrentStream(torrent, xtend(opts, {port:opts.peerPort}))

	// Just want torrent-stream to list files.
	if (opts.list) return this._torrentStreamEngine

	// Pause/Resume downloading as needed
	this._torrentStreamEngine.on('uninterested', this._torrentStreamEngine.swarm.pause.bind(this._torrentStreamEngine.swarm))
	this._torrentStreamEngine.on('interested',	 this._torrentStreamEngine.swarm.resume.bind(this._torrentStreamEngine.swarm))

	this._torrentStreamEngine.server = this.createServer(this._torrentStreamEngine, opts)

	// Listen when torrent-stream is ready, by default a random port.
	this._torrentStreamEngine.on('ready', this._torrentStreamEngine.server.listen.bind(this._torrentStreamEngine.server, opts.port || 0, opts.hostname))

	this._torrentStreamEngine.listen()

	return this._torrentStreamEngine
}


Peerflix.prototype._handler = function(exec) {
	var wires = this._torrentStreamEngine.swarm.wires
	var swarm = this._torrentStreamEngine.swarm
	var host = this._argv.hostname || address()
	var href = 'http://'+host+':'+this._torrentStreamEngine.server.address().port+'/'
	var localHref = 'http://localhost:'+this._torrentStreamEngine.server.address().port+'/'
	var filename = this._torrentStreamEngine.server.index.name.split('/').pop().replace(/\{|\}/g, '')
	var filelength = this._torrentStreamEngine.server.index.length
	var paused = false
	var timePaused = 0
	var pausedAt = null

	if (this._argv.all) {
		filename = this._torrentStreamEngine.torrent.name
		filelength = this._torrentStreamEngine.torrent.length
		href += '.m3u'
		localHref += '.m3u'
	}

	var player = exec(this._argv, localHref, href);

	process.stdout.write(new Buffer('G1tIG1sySg==', 'base64')) // clear for drawing

	var interactive = !player && process.stdin.isTTY && !!process.stdin.setRawMode

	if (interactive) {
		keypress(process.stdin)
		process.stdin.on('keypress', function(ch, key) {
			if (!key) return
			if (key.name === 'c' && key.ctrl === true) return process.kill(process.pid, 'SIGINT')
			if (key.name !== 'space') return

			if (player) return
			if (paused === false) {
				if(!this._argv.all) {
					this._torrentStreamEngine.server.index.deselect()
				} else {
					this._torrentStreamEngine.files.forEach(function(file) {
						file.deselect()
					})
				}
				paused = true
				pausedAt = Date.now()
				draw()
				return
			}

			if (!this._argv.all) {
				this._torrentStreamEngine.server.index.select()
			} else {
				this._torrentStreamEngine.files.forEach(function(file) {
					file.select()
				})
			}

			paused = false
			timePaused += Date.now() - pausedAt
			draw()
		}.bind(this))
		process.stdin.setRawMode(true)
	}

	var draw = function() {
		var active = function(wire) {
			return !wire.peerChoking
		}

		var unchoked = this._torrentStreamEngine.swarm.wires.filter(active)
		var timeCurrentPause = 0
		if (paused === true) {
			timeCurrentPause = Date.now() - pausedAt
		}
		var runtime = Math.floor((Date.now() - this._started - timePaused - timeCurrentPause) / 1000)
		var linesremaining = clivas.height
		var peerslisted = 0

		clivas.clear()
		if (this._argv.airplay) clivas.line('{green:streaming to} {bold:apple-tv} {green:using airplay}')
		else clivas.line('{green:open} {bold:'+(player || 'vlc')+'} {green:and enter} {bold:'+href+'} {green:as the network address}')
		clivas.line('')
		clivas.line('{yellow:info} {green:streaming} {bold:'+filename+' ('+this._bytes(filelength)+')} {green:-} {bold:'+this._bytes(swarm.downloadSpeed())+'/s} {green:from} {bold:'+unchoked.length +'/'+wires.length+'} {green:peers}		')
		clivas.line('{yellow:info} {green:path} {cyan:' + this._torrentStreamEngine.path + '}')
		clivas.line('{yellow:info} {green:downloaded} {bold:'+this._bytes(swarm.downloaded)+'} {green:and uploaded }{bold:'+this._bytes(swarm.uploaded)+'} {green:in }{bold:'+runtime+'s} {green:with} {bold:'+hotswaps+'} {green:hotswaps}		 ')
		clivas.line('{yellow:info} {green:verified} {bold:'+verified+'} {green:pieces and received} {bold:'+invalid+'} {green:invalid pieces}')
		clivas.line('{yellow:info} {green:peer queue size is} {bold:'+swarm.queued+'}')
		clivas.line('{80:}')

		if (interactive) {
			if (paused) clivas.line('{yellow:PAUSED} {green:Press SPACE to continue download}')
			else clivas.line('{50+green:Press SPACE to pause download}')
		}

		clivas.line('')
		linesremaining -= 9

		wires.every(function(wire) {
			var tags = []
			if (wire.peerChoking) tags.push('choked')
			clivas.line('{25+magenta:'+wire.peerAddress+'} {10:'+this._bytes(wire.downloaded)+'} {10+cyan:'+this._bytes(wire.downloadSpeed())+'/s} {15+grey:'+tags.join(', ')+'}	 ')
			peerslisted++
			return linesremaining-peerslisted > 4
		}, this)
		linesremaining -= peerslisted

		if (wires.length > peerslisted) {
			clivas.line('{80:}')
			clivas.line('... and '+(wires.length-peerslisted)+' more		 ')
		}

		clivas.line('{80:}')
		clivas.flush()
	}.bind(this)

	setInterval(draw, 500)
	draw()
}

Peerflix.prototype._bytes = function(num) {
	return numeral(num).format('0.0b')
}

module.exports = Peerflix;
