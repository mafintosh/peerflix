# peerflix

Streaming torrent client for node.js

	npm install -g peerflix

This will install a terminal app called `peerflix`.

## Usage

Simply start it with a torrent file

	peerflix http://www.clearbits.net/get/53-star-wreck---in-the-pirkinning.torrent --vlc

`peerflix` will print a terminal interface. this first line contains a address to a http server.
Using `--vlc` will open the file in vlc when it's ready to stream.

![peerflix](https://raw.github.com/mafintosh/peerflix/master/screenshot.png)

Simply open this address in vlc or similar to start viewing the file. If the torrent contains multiple files `peerflix` will choose the biggest one.

To get a full list of available options run

	peerflix --help

## Programmatic usage

``` js
var peerflix = require('peerflix');
var fs = require('fs');

var torrent = fs.readFileSync('my-test-file.torrent');
var engine = peerflix(torrent, {
	connections: 100,
	path: '/tmp/my-folder'
});

engine.server.listen(8888);
```

The above example will start a http server that listens on port 8888 and serves the files inside the torrent as http requests.
A request to `http://localhost:8888` will serve the index file (which defaults to the biggest file).

For more information see [peerflix-engine](https://github.com/mafintosh/peerflix-engine)

## License

MIT