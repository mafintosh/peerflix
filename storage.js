var partFile = require('part-file');
var piece = require('./piece');
var fs = require('fs');
var events = require('events');

module.exports = function(torrent, file, options)
{
	/* TODO: modify this to be able to handle multiple files 
	 * */
	var storage = new events.EventEmitter();
	
	var missing = [];

	var start = (file.offset / torrent.pieceLength) | 0;
	var end = ((file.offset + file.length + 1) / torrent.pieceLength) | 0;
	var dest = partFile(options.destination, torrent.pieceLength, torrent.pieces.slice(start, end+1));
	
	var lastFile = torrent.files[torrent.files.length-1];
	var pieces = torrent.pieces.map(function(_, i) {
		if (i < start) return;
		if (i > end) return;

		missing.push(i);

		if (i === torrent.pieces.length-1) return piece(((lastFile.length + lastFile.offset) % torrent.pieceLength) || torrent.pieceLength);
		return piece(torrent.pieceLength);
	});
	
	dest.on('readable', function(index) {
		index += start;
		var i = missing.indexOf(index);
		pieces[index] = null;
		if (i > -1) missing.splice(i, 1);
		storage.emit('readable', index);
		
		if (pieces.every(function(piece) { return !piece }))
			storage.emit('finished');
	});	
	
	/* Try to resume the download
	 * */
	fs.exists(options.destination, function(exists)
	{
		if (!exists) return;
		
		var i = start;
		function verifyNext()
		{
			dest.verify(i, function(err, r) {
				if (++i <= end) verifyNext();
			});
		}	
		verifyNext();
	});

	storage.missing = missing;
	storage.filename = file.name;
	storage.dest = dest;
	storage.torrent = torrent;

	storage.sizeof = function(index, offset) {
		var p = pieces[index];
		return p ? p.sizeof(offset) : 0;
	};

	storage.select = function(index, force) {
		var p = pieces[index];
		if (!p) return -1;
		var i = p.select();
		return i === -1 && force ? p.select(true) : i;
	};

	storage.deselect = function(index, offset) {
		var p = pieces[index];
		if (p) p.deselect(offset);
	};

	storage.write = function(index, offset, block) {
		var p = pieces[index];
		if (!p) return;

		var buffer = p.write(offset, block);
		if (!buffer) return;

		dest.write(index - start, buffer, function(err) {
			if (err) return p.reset();
		});
	};

	storage.read = function(index, offset, length, callback) {
		dest.read(index - start, function(err, buffer) {
			if (err) return callback(err);
			callback(null, buffer.slice(offset, offset+length));
		});
	};
	
	return storage;
}
