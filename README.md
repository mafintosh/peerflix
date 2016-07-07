# peerflix

Streaming torrent client for Node.js

```
npm install -g peerflix
```

[![build status](http://img.shields.io/travis/mafintosh/peerflix.svg?style=flat)](http://travis-ci.org/mafintosh/peerflix)

## Usage

Peerflix can be used with a magnet link or a torrent file.
To stream a video with its magnet link use the following command.

```
peerflix "magnet:?xt=urn:btih:ef330b39f4801d25b4245212e75a38634bfc856e" --vlc
```

Remember to put `"` around your magnet link since they usually contain `&`.
`peerflix` will print a terminal interface. The first line contains an address to a http server. The `--vlc` flag ensures vlc is opened when the torrent is ready to stream.

![peerflix](https://raw.github.com/mafintosh/peerflix/master/screenshot.png)

To stream music with a torrent file use the following command.

```
peerflix "http://some-torrent/music.torrent" -a --vlc
```

The `-a` flag ensures that all files in the music repository are played with vlc.
Otherwise if the torrent contains multiple files, `peerflix` will choose the biggest one.
To get a full list of available options run peerflix with the help flag.

```
peerflix --help
```

Examples of usage of could be

```
peerflix magnet-link --list # Select from a list of files to download
peerflix magnet-link --vlc -- --fullscreen # will pass --fullscreen to vlc
peerflix magnet-link --mplayer --subtitles subtitle-file.srt # play in mplayer with subtitles
peerflix magnet-link --connection 200 # set max connection to 200
```


## Programmatic usage

If you want to build your own app using streaming bittorent in Node you should checkout [torrent-stream](https://github.com/mafintosh/torrent-stream)

## Chromebook users

Chromebooks are set to refuse all incoming connections by default - to change this:  

```
sudo iptables -P INPUT ACCEPT
```

## Chromecast

If you wanna use peerflix on your chromecast checkout [peercast](https://github.com/mafintosh/peercast)
or [castnow](https://github.com/xat/castnow)

## License

MIT
