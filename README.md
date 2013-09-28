# peerflix

a streaming torrent client.
it requires node.js to run.

	npm install -g peerflix

this will install a terminal app called `peerflix`. simply call it with a torrent file

	peerflix http://www.clearbits.net/get/53-star-wreck---in-the-pirkinning.torrent --vlc

peerflix will print a terminal interface. this first line contains a address to a http server.
using `--vlc` will open the file in vlc when it's ready to stream.

![peerflix](https://raw.github.com/mafintosh/peerflix/master/screenshot.png)

simply open this address in vlc or similar to start viewing the file. If the torrent contains multiple files `peerflix` will choose the biggest one.

To get a full list of available options run

	peerflix --help
