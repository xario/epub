let fs = require('fs');
let swig = require('swig');
let url = require('url');
let express = require('express');
let qs = require('querystring');
let cheerio = require('cheerio');
let mkdirp = require('mkdirp');
let mime = require('mime');
let decomment = require('decomment');
let axios = require('axios');
let archiver = require('archiver');
var crypto = require("crypto");

let DEBUG = true;
swig.setDefaults({autoescape: false});
let contentTpl = swig.compileFile('./template/epub/OEBPS/content.opf');

let tocTpl = swig.compileFile('./template/epub/OEBPS/toc.ncx');
let log = function () {
    if (!DEBUG) {
        return;

    }
    console.log.apply(console, arguments);

};

let getFormBuildId = async function(info) {
    let data = qs.stringify({
        'js': true
    });

    let res = await axios.post('https://ereolen.dk/login/ajax', data);
    let html = res.data[1]["data"]
    let $ = cheerio.load(html);

    let $formBuildId = $('input[name=form_build_id]');
    info['formBuildId'] = $formBuildId.val();
    return info;
};

let getSessionCookie = async function (info) {
    console.log('Info: %j', info);
    let data = qs.stringify({
        'name': info['user'],
        'pass': info['pass'],
        'form_build_id': info['formBuildId'],
        'form_id': 'user_login',
        'retailer_id': info['retailer'],
        'op' : 'Log ind'
    });

    let res = await axios.post('https://ereolen.dk/system/ajax', data);
    let cookies = res.headers['set-cookie'];
    log('Cookies: %j', cookies);
    if (!cookies) {
        throw new Error('Bad login');
    }

    info['sessionCookie'] = cookies.join('; ');
    return info;
};

let logout = async function (info, callback) {
    let options = {
        headers: {
            'Host': 'ereolen.dk',
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.10; rv:36.0) Gecko/20100101 Firefox/36.0',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-us,en;q=0.5',
            'Accept-Encoding': 'gzip, deflate',
            'DNT': '1',
            'Referer': 'https://ereolen.dk/user',
            'Cookie': info['sessionCookie'],
            'Connection': 'keep-alive'
        }
    };

    await axios.get('https://ereolen.dk/user/me/logout', options);
};

let getBookInfo = async function (info) {
    let options = {
        headers: {
            'Host': 'ereolen.dk',
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.10; rv:36.0) Gecko/20100101 Firefox/36.0',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-us,en;q=0.5',
            'Accept-Encoding': 'gzip, deflate',
            'DNT': '1',
            'Referer': 'https://ereolen.dk/user',
            'Cookie': info['sessionCookie'],
            'Connection': 'keep-alive'
        }
    };

    let res = await axios.get('https://ereolen.dk/user', options);
    let $ = cheerio.load(res.data);
    let $loans = $('div.material-item');
    let books = [];
    $loans.each(function () {
        let book = {};
        let $this = $(this);
        let $btn = $this.find('a.btn--try');
        let btnText = $btn.text();
        if (btnText === "Lyt") {
            return;
        }
        let $pic = $this.find('img');
        if ($pic.length) {
            book['pic'] = {
                src: $pic.attr('src')
            };
        }

        let $title = $this.find('h3.item-title a');
        let title = $title.text();
        book['title'] = title.replace(/ : (.+)$/, '');

        let $period = $this.find('li.expires-in div.item-information-data');
        book['period'] = $period.text();

        let $readLink = $this.find('div.material-buttons a').last();
        let streamLink = $readLink.attr('href');
        let matches = streamLink.match(/^\/ting\/object\/(.+)\/read$/);
        if (!matches) {
            return;
        }

        let readId = matches[1];
        matches = readId.match(/\d+$/);
        if (!matches) {
            return;
        }

        let streamId = matches[0];

        book['readId'] = readId;
        book['streamId'] = streamId;

        books.push(book);
    });

    let $logOutLink = $('ul.sub-menu li a.menu-item').last();
    info['books'] = books;
    log('getBookInfo: %j', info);

    return info;
};
let promisify = require('util').promisify;
let stream = require('stream');
const finished = promisify(stream.finished);

async function downloadFile(fileUrl, outputLocationPath, headers = {}) {
    const writer = fs.createWriteStream(outputLocationPath);
    return axios({
        method: 'get',
        url: fileUrl,
        responseType: 'stream',
        headers: headers
    }).then(async response => {
        response.data.pipe(writer);
        return finished(writer);
    });
}

let getImages = async function (info) {
    let getImage = async function (book) {
        let pic = book['pic'];
        if (!pic) {
            book['pic'] = {
                localSrc: '/pics/books/none.jpg'
            };

            return book;
        }

        let streamId = book['streamId'];
        let src = pic['src'];
        let localPath = './htdocs/pics/books/' + streamId;
        if (!fs.existsSync(localPath)) {
            await downloadFile(src, localPath);
        }

        pic['localSrc'] = '/pics/books/' + streamId;
        return book;
    };
    for (const book of info['books']) {
        await getImage(book);
    }

    return info;
};

let getOrderId = async function (info) {
    let options = {
        headers: {
            'Host': 'ereolen.dk',
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.10; rv:36.0) Gecko/20100101 Firefox/36.0',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-us,en;q=0.5',
            'Accept-Encoding': 'gzip, deflate',
            'DNT': '1',
            'Referer': 'https://ereolen.dk/user',
            'Cookie': info['sessionCookie'],
            'Connection': 'keep-alive'
        }
    };

    let res = await axios.get('https://ereolen.dk/ting/object/' + info['readId'] + '/read', options);
    let matches = res.data.match(/data-id="(.*)"/);
    if (!matches) {
        callback('No order id found', null);
        return;
    }

    info['orderId'] = matches[1];
    return info
};

let getSessionId = async function (info) {
    let options = {
        headers: {
            'Host': 'ereolen.dk',
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.10; rv:36.0) Gecko/20100101 Firefox/36.0',
            'Accept': 'application/json, text/javascript, */*; q=0.01',
            'Accept-Language': 'en-us,en;q=0.5',
            'Accept-Encoding': 'gzip, deflate',
            'DNT': '1',
            'X-Requested-With': 'XMLHttpRequest',
            'Referer': 'https://ereolen.dk/ting/object/' + info['readId'] + '/read',
            'Cookie': info['sessionCookie'],
            'Connection': 'keep-alive'
        }
    };

    let res = await axios.get('https://ereolen.dk/reol_use_loan/reader/session/renew/' + info['orderId'], options);
    info['sessionId'] = res.data['SessionId'];
    return info;
};

let getTimestamp = function () {
    let date = new Date();
    let timestamp = date.getTime();
    delete date;
    return timestamp;
};

let getJQueryId = async function (info) {
    let rand = Math.floor(Math.random() * 9999999999999999) + 1
    let timestamp = getTimestamp();
    info['jQueryId'] = 'jQuery1720' + rand + '_' + timestamp;
    return info;
};

let getASPSessionCookie = async function (info) {
    let options = {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.10; rv:36.0) Gecko/20100101 Firefox/36.0',
            'Host': 'streaming.pubhub.dk',
            'Accept': '*/*',
            'Accept-Language': 'en-us,en;q=0.5',
            'Accept-Encoding': 'gzip, deflate',
            'DNT': '1',
            'Referer': 'https://ereolen.dk/ting/object/' + info['readId'] + '/read',
            'Connection': 'keep-alive'
        }
    };

    let res = await axios.get('https://streaming.pubhub.dk/publicstreaming_v2/v2/' + info['sessionId'] + '/' + info['orderId'] + '/wordcount/?callback=' + info['jQueryId'] + '&_=' + getTimestamp(), options);
    let headers = res['headers'];
    let cookies = headers['set-cookie'];
    if (!cookies) {
        throw new Error('No cookies found');
    }

    let cookie = cookies[0];
    let matches = cookie.match(/^(.*); path/);
    info['aspSessionCookie'] = matches[1];
    return info;
};

let getContent = async function (info) {
    log('Getting content');
    let jQueryId = info['jQueryId'];
    let jqPattern = new RegExp(jQueryId + '\\((.*)\\);');
    let filterRes = function (data) {
        let matches = jqPattern.exec(data);
        return matches[1];
    };

    let getFile = async function (fileUrl, outputPath) {
        let parts = url.parse(fileUrl, true);
        let path = parts['pathname'];
        let headers = {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.10; rv:36.0) Gecko/20100101 Firefox/36.0',
            'Host': 'streaming.pubhub.dk',
            'Accept': '*/*',
            'Accept-Language': 'en-us,en;q=0.5',
            'Accept-Encoding': 'gzip, deflate',
            'DNT': '1',
            'Referer': 'https://ereolen.dk/ting/object/' + info['readId'] + '/read',
            'Cookie': info['aspSessionCookie'],
            'Connection': 'keep-alive'
        }

        await downloadFile('https://streaming.pubhub.dk' + path, outputPath, headers);
    };

    let getChunk = async function (id) {
        let timestamp = getTimestamp();
        timestamp += id * 1234;

        let options = {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.10; rv:36.0) Gecko/20100101 Firefox/36.0',
                'Host': 'streaming.pubhub.dk',
                'Accept': '*/*',
                'Accept-Language': 'en-us,en;q=0.5',
                'Accept-Encoding': 'gzip, deflate',
                'DNT': '1',
                'Referer': 'https://ereolen.dk/ting/object/' + info['readId'] + '/read',
                'Cookie': info['aspSessionCookie'],
                'Connection': 'keep-alive'
            }
        };

        let res = await axios.get('https://streaming.pubhub.dk/publicstreaming_v2/v2/' + info['sessionId'] + '/' + info['orderId'] + '/' + id + '/?callback=' + info['jQueryId'] + '&_=' + timestamp, options);

        let filtered = filterRes(res.data);
        return JSON.parse(filtered);
    };

    let first = await getChunk(1);
    let chunks = [first];
    let count = first['TotalIndexCount'];
    for (let i = 2; i <= count; i++) {
        chunks.push(await getChunk(i));
    }

    let prepareEPub = async function(chunks) {
        log('Preparing ePub');
        let dirPath = '/tmp/' + info['streamId'] + '/';
        mkdirp.sync(dirPath);
        let oebpsPath = dirPath + 'OEBPS/';
        let getFileName = function (fileUrl) {
            let name = fileUrl.substring(fileUrl.lastIndexOf('/') + 1);
            name = name.toLowerCase();
            return name.replace(/[^a-zA-Z0-9\.]/, '');
        };

        let addedExternalFiles = {};
        let externalFiles = [];
        let stripLinks = function (source) {
            return source.replace(/<\/?a[^>]*>/g, '');
        };

        let saveChunk = async function (chunk) {
            let prepareSource = function(source) {
                source = stripLinks(source);
                source = decomment.text(source);
                let matches = source.match(/[\"|\'](https?\:[^\"|\']+)["|\']/g);
                for (let i in matches) {
                    let match = matches[i];
                    let external = match.replace(/[\"|\'](.+)[\"|\']/, '$1');
                    if (!external.match(/^https:\/\/streaming\.pubhub\.dk/)) {
                        continue;
                    }

                    let type = mime.lookup(external);
                    if (!type.match(/[font|image|css]/)) {
                        continue;
                    }

                    let fileName = getFileName(external);
                    source = source.replace(external, fileName);

                    if (addedExternalFiles[fileName]) {
                        continue;
                    }

                    externalFiles.push(external);
                    addedExternalFiles[fileName] = 1;
                }

                return source.replace(/ ?i=[\"|\']\d+[\"|\']/g, '');
            };

            let writeXHtml = function (source) {
                let index = chunk['Index'];
                let chapterName = index + '.xhtml';
                let chunkFile = oebpsPath + chapterName;
                fs.writeFileSync(chunkFile, source);
            };

            writeXHtml(prepareSource(chunk['Source']));
        };

        let getFont = async function (fontUrl) {
            let fontName = getFileName(fontUrl);
            log('%s: Trying to get font', fontName);
            let newPath = oebpsPath + fontName;
            let tmpPath = '/fonts/' + fontName;
            if (!fs.existsSync(tmpPath)) {
                await getFile(fontUrl, "/fonts/" + fontName);
            }
            fs.copyFileSync(tmpPath, newPath);
        };

        let fetchExternal = async function (external) {
            let fileName = getFileName(external);
            log('External: %s', fileName);
            let newPath = oebpsPath + fileName;
            let extension = fileName.substring(-3);
            let fontExtensions = ['ttf', 'otf', 'fon', 'ttc'];
            if (fontExtensions.indexOf(extension) > -1) {
                return await getFont(external);
            }

            return await getFile(external, newPath);
        };

        let fetchExternals = async function() {
            log('Fetching externals');
            for (let i in externalFiles) {
                let external = externalFiles[i];
                await fetchExternal(external);
            }
        };

        let addMetaFiles = function() {
            let writeMimetype = function() {
                log('Writing mimetype');
                let from = './template/epub/mimetype';
                let to = dirPath + 'mimetype';
                fs.copyFileSync(from, to);
            };

            let writeContainer = function() {
                log('Copying container.xml');
                let from = './template/epub/META-INF/container.xml';
                let to = dirPath + 'META-INF/container.xml';
                fs.copyFileSync(from, to);
            };

            let writeContent = function() {
                log('Writing content.opf');
                let externals = [];
                for (let i in externalFiles) {
                    let externalUrl = externalFiles[i];
                    let fileName = getFileName(externalUrl);
                    let fileType = mime.lookup(fileName);
                    let external = {
                        name: fileName,
                        type: fileType
                    };

                    externals.push(external);
                }

                let content = contentTpl({
                    title: info['title'],
                    author: info['author'],
                    externals: externals,
                    chunks: chunks
                });

                fs.writeFileSync(oebpsPath + 'content.opf', content);
            };

            let writeToc = function () {
                log('Writing toc.ncx');
                let content = tocTpl({
                    title: info['title'],
                    chunks: chunks
                });

                fs.writeFileSync(oebpsPath + 'toc.ncx', content);
            };

            writeMimetype();
            writeContainer();
            writeContent();
            writeToc();
        };

        mkdirp.sync(oebpsPath)
        for (let i in chunks) {
            await saveChunk(chunks[i])
        }
        await fetchExternals();
        mkdirp.sync(dirPath + 'META-INF/');
        addMetaFiles();

        return info;
    };

    return await prepareEPub(chunks);
};

let makeEPub = async function (info, callback) {
    log('Creating epub');
    let streamId = info['streamId'];
    let dirPath = '/tmp/' + streamId + '/';
    let oebpsPath = dirPath + 'OEBPS/';
    let zip = archiver('zip');

    log('Adding mimetype');
    let mimeTypeStream = fs.createReadStream('/tmp/' + streamId + '/mimetype');
    zip.append(mimeTypeStream, {name: 'mimetype', store: true});

    log('Adding container.xml');
    let containerStream = fs.createReadStream('/tmp/' + streamId + '/META-INF/container.xml');
    zip.append(containerStream, {name: 'META-INF/container.xml'});

    let addToZip = function (file) {
        let filePath = oebpsPath + file;
        file = 'OEBPS/' + file;
        log('Adding ' + file);
        let stream = fs.createReadStream(filePath);
        zip.append(stream, {name: file});
    };

    let makeZip = async function (err) {
        log('Making zip archive');

        if (err) {
            log('Error creating zip archive1: %s', err);
            callback(err);
            return;
        }

        zip.on('error', function (err) {
            callback(err);
        });

        let output = fs.createWriteStream('/tmp/' + streamId + '.epub');
        zip.pipe(output);

        await zip.finalize();
        return info;
    };

    let filePaths = fs.readdirSync(oebpsPath);
    for (let i in filePaths) {
        let file = filePaths[i];
        addToZip(file);
    }

    await makeZip();
};

let loginTpl = swig.compileFile('./template/client/login.html');
let disclaimerTpl = swig.compileFile('./template/client/disclaimer.html');
let booksTpl = swig.compileFile('./template/client/books.html');

let bodyParser = require('body-parser');
let session = require('express-session');

let app = express();
app.use(bodyParser.urlencoded({
    extended: true
}));

app.use(bodyParser.json());

app.use(session({
    secret: crypto.randomBytes(128).toString('hex'),
    name: 'sessionId'
}));

app.use(express.static('./htdocs'));
app.get('/', function (req, res) {
    res.redirect(!!req.session.info ? 'books' : 'login');
});

let getMenuItems = function (req) {
    let menu = [];
    menu.push({
        name: 'Brugsbetingelser',
        link: '/disclaimer'
    });

    if (!!req.session.info) {
        menu.push({
                name: 'Bøger',
                link: '/books'
            }, {
                name: 'Log ud',
                link: '/logout'
            }
        );
    } else {
        menu.push({
            name: 'Log ind',
            link: '/login'
        });
    }

    return menu;
};

app.get('/books', async function (req, res) {
    let info = req.session.info;
    if (!info) {
        res.redirect('login');
        return;
    }

    try {
        info = await getBookInfo(info);
        info = await getImages(info);
    } catch (err) {
        log('Error getting books: %s', err);
        res.redirect('login');
        return;
    }

    res.setHeader('Content-type', 'text/html');
    res.writeHead(200);
    info['menu'] = getMenuItems(req);
    let html = booksTpl(info);
    res.end(html);
});

app.get('/disclaimer', function (req, res) {
    res.setHeader('Content-type', 'text/html');
    res.writeHead(200);
    let data = {
        menu: getMenuItems(req)
    };

    let html = disclaimerTpl(data);
    res.end(html);
});

app.get('/login', function (req, res) {
    res.setHeader('Content-type', 'text/html');
    res.writeHead(200);
    let data = {};
    if (req.session.loginError) {
        data['errorMessage'] = req.session.loginError;
        delete req.session.loginError;
    }

    data['menu'] = getMenuItems(req);
    let html = loginTpl(data);
    res.end(html);
});

app.post('/login', async function (req, res) {
    let info = {
        user: req.body.name,
        pass: req.body.pass,
        retailer: req.body.retailer
    };

    try {
        info = await getFormBuildId(info);
        info = await getSessionCookie(info);
    } catch (err) {
        log('Error: %s', err);
        req.session.loginError = err;
        res.redirect('login');
        return;
    }

    req.session.regenerate(function () {
        req.session.info = info;
        res.redirect('books');
    });
});

app.get('/generate/:id', async function (req, res) {
    let info = req.session.info;
    if (!info) {
        res.redirect('login');
        return;
    }

    let id = parseInt(req.params.id) - 1;
    let book = info['books'][id];
    if (!book) {
        res.writeHead(200);
        res.end('No book found');
        return;
    }

    let ePubPath = book.ePubPath || '/tmp/' + book.streamId + '.epub';
    if (!fs.existsSync(ePubPath)) {
        try {
            info = {
                sessionId: info['sessionId'],
                streamId: book['streamId'],
                readId: book['readId'],
                author: book['author'],
                title: book['title'],
                sessionCookie: info['sessionCookie']
            };

            info = await getOrderId(info);
            info = await getSessionId(info);
            info = await getJQueryId(info);
            info = await getASPSessionCookie(info);
            info = await getContent(info);
            await makeEPub(info);
        } catch (err) {
            log('Error creating ePub: %s', err);
            res.writeHead(200);
            res.end('Error');
            return;
        }
    }

    book['ePubPath'] = ePubPath;
    res.writeHead(200);
    res.end('done');
});

app.get('/download/:id', function (req, res) {
    let info = req.session.info;
    if (!info) {
        res.redirect('login');
        return;
    }

    let id = parseInt(req.params.id) - 1;
    let book = info['books'][id];

    let error = function (text) {
        res.writeHead(200);
        res.end(text);
    };

    if (!book || !book['ePubPath']) {
        error('No book found');
    }

    let fileName = book['title'] + '.epub';
    let file = book['ePubPath'];
    res.setHeader('Content-disposition', 'attachment; filename="' + fileName + '"');
    res.setHeader('Content-type', 'application/epub+zip');

    console.log("File: %s", file);
    fs.exists(file, function (exists) {
        if (!exists) {
            error('Error generating file');
            return
        }

        let fileStream = fs.createReadStream(file);
        fileStream.pipe(res);
    });
});

app.get('/logout', async function (req, res) {
    let info = req.session.info;
    if (info) {
        await logout(info);
        req.session.destroy();
    }

    res.redirect('/');
});
app.listen(8001, function () {
    console.log('listening on port 8001!')
});

/*
let lee = require('letsencrypt-express');
let options = {
    server: 'https://acme-v01.api.letsencrypt.org/directory',
    email: 'letsencrypt@xar.io',
    agreeTos: true,
    approveDomains: [ 'epub.xar.io' ],
    app: app
};

lee
	.create(options)
	.listen(8080, 4443);
/*
app.listen(8001, function () {
    console.log('listening on port 80!')
});
/*
let options = {
	key  : fs.readFileSync( './ssl/ssl.key' ),
	cert : fs.readFileSync( './ssl/ssl.crt' )
};
https.createServer( options, app ).listen( 80, function() {
	console.log( 'Express server listening on port 80' );
} );
*/
