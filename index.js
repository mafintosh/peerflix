var engine = require('torrent-stream');
var http = require('http');
var rangeParser = require('range-parser');
var url = require('url');
var mime = require('mime');
var pump = require('pump');

var createServer = function(e, index) {
	var server = http.createServer();

	var onready = function() {
		if (typeof index !== 'number') {
			index = e.files.reduce(function(a, b) {
				return a.length > b.length ? a : b;
			});
			index = e.files.indexOf(index);
		}

		e.files[index].select();
		server.index = e.files[index];
	};

	if (e.torrent) onready();
	else e.on('ready', onready);

	server.on('request', function(request, response) {
		var u = url.parse(request.url);

		if (u.pathname === '/favicon.ico') return response.end();
		if (u.pathname === '/') u.pathname = '/'+index;

		var i = Number(u.pathname.slice(1));

		if (isNaN(i) || i >= e.files.length) {
			response.statusCode = 404;
			response.end();
			return;
		}

		var file = e.files[i];
		var range = request.headers.range;
		range = range && rangeParser(file.length, range)[0];
		response.setHeader('Accept-Ranges', 'bytes');
		response.setHeader('Content-Type', mime.lookup(file.name));

		if (!range) {
			response.setHeader('Content-Length', file.length);
			if (request.method === 'HEAD') return response.end();
			pump(file.createReadStream(), response);
			return;
		}

		response.statusCode = 206;
		response.setHeader('Content-Length', range.end - range.start + 1);
		response.setHeader('Content-Range', 'bytes '+range.start+'-'+range.end+'/'+file.length);

		if (request.method === 'HEAD') return response.end();
		pump(file.createReadStream(range), response);
	});

	return server;
};

module.exports = function(torrent, opts) {
	if (!opts) opts = {};
	var e = engine(torrent, opts);
	if (!opts.list) {
		e.server = createServer(e, opts.index);
	};
	return e;
};