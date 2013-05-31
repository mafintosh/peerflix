var http = require('http');
var rangeParser = require('range-parser');
var mime = require('mime');
var Readable = require('readable-stream');
var util = require('util');

var MIN_BUFFER = 1.5 * 1000 * 1000;

var pipeline = function(inp, out) {
	inp.pipe(out);
	out.on('close', function() {
		inp.destroy();
	});
};

module.exports = function(storage, file, options) {
	var dest = storage.dest;
	var missing = storage.missing;
	var torrent = storage.torrent;

	var piecesToBuffer = Math.ceil((options.buffer || MIN_BUFFER) / torrent.pieceLength);
	var start = (file.offset / torrent.pieceLength) | 0;
	var end = ((file.offset + file.length + 1) / torrent.pieceLength) | 0;
		
	var PieceStream = function(range) {
		Readable.call(this);
		range = range || {start:0, end:file.length-1};
		this.position = ((range.start + file.offset) / torrent.pieceLength) | 0;
		this.remaining = range.end - range.start + 1;
		this.skip = (range.start + file.offset) % torrent.pieceLength;
		this.destroyed = false;
		this._buffer = this.position + Math.min(piecesToBuffer, (this.remaining / torrent.pieceLength) | 0);
		this._onreadable = null;

		server.position = this.position;
	};

	util.inherits(PieceStream, Readable);

	PieceStream.prototype._read = function() {
		if (!this.remaining) return this.push(null);

		var self = this;
		var onread = function(err, data) {
			if (err) return self.emit('error', err);
			if (self.skip) data = data.slice(self.skip);
			if (data.length > self.remaining) data = data.slice(0, self.remaining);
			self.skip = 0;
			self.remaining -= data.length;
			if (self.destroyed) return;
			self.push(data);
			server.position = self.position;
		};

		if (!this.buffering()) return dest.read(this.position++ - start, onread);

		this._onreadable = function(index) {
			if (self.buffering()) return;
			dest.removeListener('readable', self._onreadable);
			dest.read(self.position++ - start, onread);
			server.position = self.position;
		};

		dest.on('readable', this._onreadable);
	};

	PieceStream.prototype.buffering = function() {
		for (var i = this.position; i < this._buffer; i++) {
			if (!dest.readable(i - start)) return true;
		}
		return !dest.readable(this.position - start);
	};

	PieceStream.prototype.destroy = function() {
		this.destroyed = true;
		if (this._onreadable) dest.removeListener('readable', this._onreadable);
		this.emit('close');
	};

	var isAvi = /\.avi$/i.test(file.name);
	var prioritize = function(i) {
		missing.sort(function(a, b) {
			if (a === end && !isAvi) return -1;
			if (b === end && !isAvi) return 1;
			if (a >= i && b < i) return -1;
			if (b >= i && a < i) return 1;
			return a - b;
		});
	};

	var stream = function(range) {
		var s = new PieceStream(range);
		prioritize(s.position);
		return s;
	};

	var server = http.createServer(function(request, response) {
		var range = request.headers.range;

		request.connection.setTimeout(0);
		response.setHeader('Accept-Ranges', 'bytes');
		response.setHeader('Content-Type', mime.lookup(file.name));

		range = range && rangeParser(file.length, range)[0];

		if (!range) {
			response.setHeader('Content-Length', file.length);
			if (request.method === 'HEAD') return response.end();
			pipeline(stream(), response);
			return;
		}

		response.statusCode = 206;
		response.setHeader('Content-Length', range.end - range.start + 1);
		response.setHeader('Content-Range', 'bytes '+range.start+'-'+range.end+'/'+file.length);

		if (request.method === 'HEAD') return response.end();
		pipeline(stream(range), response);
	});

	server.position = 0;
	prioritize(0);

	server.listen(options.port || 8888);
	server.on('error', function() {
		server.listen(0);
	});

	return server;
};
