# stream

Streaming torrent client for Node.js

```
npm install -g @meteor314/stream
```

## Usage

stream-cli can be used with a magnet link or a torrent file.
To stream a video with its magnet link use the following command.

```
stream "magnet:?xt=urn:btih:ef330b39f4801d25b4245212e75a38634bfc856e" --vlc
```

Remember to put `"` around your magnet link since they usually contain `&`.
`stream` will print a terminal interface. The first line contains an address to a http server. The `--vlc` flag ensures vlc is opened when the torrent is ready to stream.

![stream](https://raw.github.com/meteor314/stream/master/screenshot.png)

To stream music with a torrent file use the following command.

```
stream "http://some-torrent/music.torrent" -a --vlc
```

The `-a` flag ensures that all files in the music repository are played with vlc.
Otherwise if the torrent contains multiple files, `stream` will choose the biggest one.
To get a full list of available options run stream with the help flag.

```
stream --help
```

Examples of usage of could be

```
stream magnet-link --list # Select from a list of files to download
stream magnet-link --vlc -- --fullscreen # will pass --fullscreen to vlc
stream magnet-link --mplayer --subtitles subtitle-file.srt # play in mplayer with subtitles
stream magnet-link --connection 200 # set max connection to 200
```


## Programmatic usage

If you want to build your own app using streaming bittorrent in Node you should checkout [torrent-stream](https://github.com/mafintosh/torrent-stream)

## Chromebook users

Chromebooks are set to refuse all incoming connections by default - to change this:  

```
sudo iptables -P INPUT ACCEPT
```

## Chromecast

If you wanna use stream on your chromecast checkout [peercast](https://github.com/mafintosh/peercast)
or [castnow](https://github.com/xat/castnow)

## License

MIT
