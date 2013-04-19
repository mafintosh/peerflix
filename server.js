var http = require('http');
var rangeParser = require('range-parser');
var mime = require('mime');
var partFile = require('part-file');
var Readable = require('readable-stream');
var piece = require('./piece');
var util = require('util');

var MIN_BUFFER = 1.5 * 1000 * 1000;

var pipeline = function(inp, out) {
	inp.pipe(out);
	out.on('close', function() {
		inp.destroy();
	});
};

module.exports = function(torrent, file, options) {
	var destination = options.destination;
	var piecesToBuffer = Math.ceil((options.buffer || MIN_BUFFER) / torrent.pieceLength);

	var PieceStream = function(range) {
		Readable.call(this);
		range = range || {start:0, end:file.length-1};
		this.position = ((range.start + file.offset) / torrent.pieceLength) | 0;
		this.remaining = range.end - range.start + 1;
		this.skip = (range.start + file.offset) % torrent.pieceLength;
		this.destroyed = false;
		this._buffer = this.position + Math.min(piecesToBuffer, (this.remaining / torrent.pieceLength) | 0);
		this._onreadable = null;
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
			if (!self.destroyed) self.push(data);
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

	var missing = [];

	var start = (file.offset / torrent.pieceLength) | 0;
	var end = ((file.offset + file.length + 1) / torrent.pieceLength) | 0;
	var dest = partFile(destination, torrent.pieceLength, torrent.pieces.slice(start, end+1));

	var prioritize = function(i) {
		missing.sort(function(a, b) {
			if (a === end) return -1;
			if (b === end) return 1;
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

	var lastFile = torrent.files[torrent.files.length-1];
	var pieces = torrent.pieces.map(function(_, i) {
		if (i < start) return;
		if (i > end) return;

		missing.push(i);

		if (i === torrent.pieces.length-1) return piece(((lastFile.length + lastFile.offset) % torrent.pieceLength) || torrent.pieceLength);
		return piece(torrent.pieceLength);
	});

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

	dest.on('readable', function(index) {
		index += start;
		var i = missing.indexOf(index);
		pieces[index] = null;
		if (i > -1) missing.splice(i, 1);
		server.emit('readable', index);
	});

	prioritize(0);

	server.position = 0;
	server.missing = missing;
	server.filename = file.name;
	server.destination = destination;

	server.sizeof = function(index, offset) {
		var p = pieces[index];
		return p ? p.sizeof(offset) : 0;
	};

	server.select = function(index, force) {
		var p = pieces[index];
		if (!p) return -1;
		var i = p.select();
		return i === -1 && force ? p.select(true) : i;
	};

	server.deselect = function(index, offset) {
		var p = pieces[index];
		if (p) p.deselect(offset);
	};

	server.write = function(index, offset, block) {
		var p = pieces[index];
		if (!p) return;

		var buffer = p.write(offset, block);
		if (!buffer) return;

		dest.write(index - start, buffer, function(err) {
			if (err) return p.reset();
		});
	};

	server.read = function(index, offset, length, callback) {
		dest.read(index - start, function(err, buffer) {
			if (err) return callback(err);
			callback(null, buffer.slice(offset, offset+length));
		});
	};

	return server;
};
