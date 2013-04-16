var crypto = require('crypto');

var BLOCK_SIZE = 1 << 14;

var BLOCK_BLANK = 0;
var BLOCK_RESERVED = 1;
var BLOCK_WRITTEN = 2;

var sha1 = function(data) {
	return crypto.createHash('sha1').update(data).digest('hex');
};

var Piece = function(length) {
	if (!(this instanceof Piece)) return new Piece(length);

	this.length = length;
	this.buffer = null;
	this.blocks = null;
	this.blocksWritten = 0;
};

Piece.prototype.__proto__ = process.EventEmitter.prototype;

Piece.prototype.select = function() {
	if (!this.blocks) this.clear();
	for (var i = 0; i < this.blocks.length; i++) {
		if (this.blocks[i]) continue;
		this.blocks[i] = BLOCK_RESERVED;
		return i * BLOCK_SIZE;
	}
	return -1;
};

Piece.prototype.sizeof = function(offset) {
	return Math.min(BLOCK_SIZE, this.length - offset);
};

Piece.prototype.deselect = function(offset) {
	var i = (offset / BLOCK_SIZE) | 0;
	if (!this.blocks) this.clear();
	if (this.blocks[i] === BLOCK_RESERVED) this.blocks[i] = BLOCK_BLANK;
};

Piece.prototype.clear = function() {
	this.blocks = new Uint8Array(Math.ceil(this.length / BLOCK_SIZE));
};

Piece.prototype.write = function(offset, buffer) {
	var i = (offset / BLOCK_SIZE) | 0;
	if (!this.blocks) this.clear();
	if (this.blocks[i] === BLOCK_WRITTEN) return;

	this.buffer = this.buffer || new Buffer(this.length);
	this.blocks[i] = BLOCK_WRITTEN;
	this.blocksWritten++;
	buffer.copy(this.buffer, offset);

	var firstBlank = Math.min( Array.prototype.indexOf.call(this.blocks, BLOCK_BLANK), 
							   Array.prototype.indexOf.call(this.blocks, BLOCK_RESERVED) );
	this.emit("progress", Math.min( this.buffer.length,  ( (firstBlank == -1) ? this.blocks.length : firstBlank ) * BLOCK_SIZE));
	
	return this.blocksWritten === this.blocks.length && this.buffer;
};

Piece.prototype.reset = function() {
	this.buffer = null;
	this.blocks = null;
	this.blocksWritten = 0;
};

module.exports = Piece;
