var express = require('express');
var bodyParser = require('body-parser');
var cors = require('cors');
var fs = require("fs");
var scrapeIt = require("scrape-it");
var ffmpeg = require('fluent-ffmpeg');
var XMLHttpRequest = require("xmlhttprequest").XMLHttpRequest;

var YouTube = require('youtube-node');
var youTube = new YouTube();
youTube.setKey('AIzaSyD-JIlbfWbE9Y73nbBXRYhDNdpYLJoWCk4');

var gcloud = require('gcloud');
var gcs = gcloud.storage({
  projectId: "karaokey-163903",
  keyFilename: 'key/jsonkey.json',
});
var bucket = gcs.bucket('karaokey-bucket');

var speech = require('@google-cloud/speech');
var speechClient = speech({
  projectId: 'karaokey-163903',
  keyFilename: 'key/jsonkey.json'
});

var app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.raw({ type: 'audio/wav', limit: '50mb' }));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(__dirname + '/public'));

app.set('port', (process.env.PORT || 5000));
app.set('views', __dirname + '/views');
app.set('view engine', 'ejs');

var users = {};

app.post('/search', function(request, response) {
    response.header("Access-Control-Allow-Origin", "*");
    console.log("/search - Received data:", request.body);

    var song = request.body.song;
    var artist = request.body.artist;
    var ingame = request.body.page;

    if (!song || !artist) {
        console.log("/search - Input error: song=", song, ", artist=", artist);
        return response.send({});
    }

    var url = "http://www.metrolyrics.com/";
    var path = song.replace(/ /g, '-') + "-lyrics-" + artist.replace(/ /g, '-') + ".html";
    var uuid = guid();
    if (ingame == "ingame") {
        users[uuid] = {};
        users[uuid].actualLyrics = "";
        users[uuid].playerLyrics = "";
        users[uuid].artist = artist;
        users[uuid].song = song;
    }

    console.log("/search - Scraping metrolyrics: ", url + path);
    scrapeIt(url + path, {
        verse: ".verse",
        title: ".title"
    }).then(page => {
        youTube.search(song + " " + artist, 2, function(error, result) {
            if (error) {
                console.log("/search - ERROR - Youtube search failed", error);
                return response.send({});
            }
            var id = result.items[0].id.videoId;
            var video = "https://www.youtube.com/embed/" + id;
            var lyrics = parseSong(page.verse);
            if (ingame == "ingame") {
                users[uuid].actualLyrics = lyrics;
                users[uuid].video = video;
            }
            console.log("/search - Sending back data", video, uuid);
            response.send({
                lyrics: lyrics,
                video: video,
                uuid: uuid
            });
        });
    });
})

function parseSong (song) {
    // song = song.replace(/\n/g, '</br>').replace(/<p class='verse'>/g, '<p>');
    return song;
}

app.post('/score', function (request, response) {
    response.header("Access-Control-Allow-Origin", "*");
    console.log("/score - Received data:", request.body);

    var uuid = request.body.uuid;

    if (!users[uuid] || !users[uuid]) {
        console.log("/score - ERROR - Unrecognized uuid: ", uuid);
        return response.send({});
    }

    var data = users[uuid];
    var actualLyrics = data.actualLyrics;
    var playerLyrics = data.playerLyrics;
    var artist = data.artist;
    var song = data.song;

    var len = actualLyrics.length || 1;
    var dist = ldist(actualLyrics, playerLyrics);
    var score = (len - dist)/(len);
    
    console.log("/score - Player lyrics: ", playerLyrics);
    console.log("/score - Distance: ", dist, ", len", len);
    console.log("/score - Score: ", score);

    response.send({
        score: len - dist,
        max: len,
        playerLyrics: playerLyrics,
        actualLyrics: actualLyrics,
        artist: artist,
        song: song
    });
});

app.post('/file', function (req, res) {
    req.setTimeout(0);
    res.connection.setTimeout(0)

    var uuid = req.header('uuid');
    console.log("/file - Received uuid: ", uuid);

    if (!uuid || !users[uuid]) {
        console.log("/file - ERROR - Unrecognized uuid: ", uuid);
        return response.send({});
    }

    // var wait = function () {
    //     setTimeout(function () {
    //         if (waitCount != 0) {
    //             console.log("wait... " + waitCount);
    //             res.write("");
    //             waitCount++;
    //             wait();
    //         }
    //     }, 500)
    // };
    // wait(); 

    var date = new Date();
    var filename = "newaudio" + date.getTime() + ".wav";
    var destination = "newaudio" + date.getTime() + ".flac";
    console.log("/file - Writing file: ", destination);

    fs.writeFile(filename, req.body, function(err) {
        if (err) {
            console.log("/file - ERROR - File writing error: ", err);
            response.send({});
        }

        ffmpeg()
        .input(filename)
        .audioChannels(1)
        .audioFrequency(48000)
        .audioCodec('flac')
        .save(destination)
        .on('start', () => {
            console.log("/file - ffmpeg starting encoding");
        })
        .on('end', () => {
            console.log("/file - ffmpeg finished encoding");
            bucket.upload(destination, function(err, file) {
                if (err) {
                    console.log("/file - Google upload failed", err);
                    response.send({});
                }

                var obj = {
                    "config": {
                        "encoding":"FLAC",
                        "sampleRate": 48000,
                        "languageCode": "en-US"
                    },
                    "audio": {
                      "uri":"gs://karaokey-bucket/" + destination
                    }
                }
                console.log("/file - Google upload successful");
                console.log("/file - Sending object for recog: " + JSON.stringify(obj));

                // speechClient.recognize(destination, {
                //     encoding: 'FLAC',
                //     sampleRate: 48000,
                //     languageCode: "en-US"
                // }, function(err, transcript, response) {
                //     if (err) {
                //         console.log("/file - ERROR - Google speech failed:", err);;
                //         response.send({});
                //     }

                //     console.log("/file - Google speech successful: Response----------------------------");
                //     console.log("/file - ", JSON.stringify(response));
                //     console.log("/file - End response -------------------------------------------------");
                //     // waitCount = 0;
                //     if (transcript.length > 0)
                //         users[uuid].playerLyrics += "</br>";    
                //     users[uuid].playerLyrics += transcript;
                //     res.write(JSON.stringify(response));
                //     res.end();
                // });
            });
        });
    });
});

var server = app.listen(app.get('port'), function() {
  console.log('Node app is running on port', app.get('port'));
});
server.timeout = 1000 * 10 * 60;

var ldist = function(a, b){
    if (a.length == 0) return b.length; 
    if (b.length == 0) return a.length; 

    var matrix = [];

    // increment along the first column of each row
    var i;
    for (i = 0; i <= b.length; i++) {
        matrix[i] = [i];
    }

    // increment each column in the first row
    var j;
    for (j = 0; j <= a.length; j++) {
        matrix[0][j] = j;
    }

    // Fill in the rest of the matrix
    for (i = 1; i <= b.length; i++) {
        for (j = 1; j <= a.length; j++) {
            if (b.charAt(i-1) == a.charAt(j-1)) {
                matrix[i][j] = matrix[i-1][j-1];
            } else {
                matrix[i][j] = Math.min(matrix[i-1][j-1] + 1, // substitution
                               Math.min(matrix[i][j-1] + 1, // insertion
                               matrix[i-1][j] + 1)); // deletion
            }
        }
    }
    return matrix[b.length][a.length];
};

function guid() {
    function s4() {
        return Math.floor((1 + Math.random()) * 0x10000)
            .toString(16)
            .substring(1);
    }
    var str = "";
    for (var i = 0; i < 8; i++) 
        str += s4();
    return str;
}