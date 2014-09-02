# peerflix

Streaming torrent client for Node.js

	npm install -g peerflix

## Usage

To try out peerflix start it with a magnet link or torrent file

	peerflix "magnet:?xt=urn:btih:ef330b39f4801d25b4245212e75a38634bfc856e" --vlc

Remember to put `"` around your magnet link since they usually contain `&`.

`peerflix` will print a terminal interface. this first line contains an address to a http server.
Using `--vlc` will open the file in vlc when it's ready to stream.

![peerflix](https://raw.github.com/mafintosh/peerflix/master/screenshot.png)

Simply open this address in vlc or similar to start viewing the file. If the torrent contains multiple files `peerflix` will choose the biggest one.

To get a full list of available options run

	peerflix --help

## Programmatic usage

If you want to build your own app using streaming bittorent in Node you should checkout [torrent-stream](https://github.com/mafintosh/torrent-stream)

## Chromebook users

Chromebooks are set to refuse all incoming connections by default - to change this:  


	sudo iptables -P INPUT ACCEPT

## License

MIT
