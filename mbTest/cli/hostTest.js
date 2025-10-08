'use strict';

const assert = require('assert'),
    api = require('../api').create(),
    port = api.port + 1,
    mb = require('../mb').create(port),
    baseTimeout = parseInt(process.env.MB_SLOW_TEST_TIMEOUT || 3000),
    timeout = 2 * baseTimeout,
    hostname = require('os').hostname(),
    BaseHttpClient = require('../baseHttpClient'),
    http = BaseHttpClient.create('http'),
    fs = require('fs-extra'),
    util = require('util'),
    dns = require('dns'),
    path = require('path');

const lookup = util.promisify(dns.lookup);

/**
 * Finds the first non-internal IPv4 address on the machine.
 * @returns {string|undefined} The IP address or undefined if not found.
 */
function getBestHost () {
    const interfaces = require('os').networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const net of interfaces[name]) {
            // Skip over non-IPv4 and internal (i.e. 127.0.0.1) addresses
            if (net.family === 'IPv4' && !net.internal) {
                return net.address;
            }
        }
    }
    return undefined;
}

describe('--host', function () {
    this.timeout(timeout);
    let host;

    before(async function () {
        // On some OS's, hostname resolves to localhost.
        // If so, we have to find a different host to bind to for the tests to be meaningful.
        try {
            const { address } = await lookup(hostname);
            if (address === '127.0.0.1' || address === '::1') {
                // This is the case on macOS that causes failures
                host = getBestHost();
            }
            else {
                host = hostname;
            }
        }
        catch (e) {
            // This can happen on some CI boxes, just assume it's not localhost
            host = getBestHost();
        }
    });

    afterEach(async function () {
        await mb.stop();
    });

    it('should allow binding to specific host', async function () {
        if (!host) {
            console.log('Skipping test: no non-localhost host found to bind to.');
            this.skip();
        }

        await mb.start(['--host', host]);

        const response = await mb.get('/'),
            links = response.body._links,
            hrefs = Object.keys(links).map(key => links[key].href);

        assert.ok(hrefs.length > 0, 'no hrefs to test');
        hrefs.forEach(href => {
            assert.ok(href.indexOf(`http://${host}`) === 0, `${href} does not use hostname`);
        });
    });

    it('should work with --configfile', async function () {
        if (!host) {
            console.log('Skipping test: no non-localhost host found to bind to.');
            this.skip();
        }

        const args = ['--host', host, '--configfile', path.join(__dirname, 'noparse.json'), '--noParse'];
        await mb.start(args);

        const response = await http.responseFor({ method: 'GET', path: '/', hostname: host, port: 4545 });

        assert.strictEqual(response.body, '<% should not render through ejs');
    });

    it('should work with mb save', async function () {
        if (!host) {
            console.log('Skipping test: no non-localhost host found to bind to.');
            this.skip();
        }

        const imposters = { imposters: [{ protocol: 'http', port: 3000, recordRequests: false, stubs: [] }] };
        await mb.start(['--host', host]);
        await mb.put('/imposters', imposters);

        await mb.save(['--host', host]);

        try {
            assert.ok(fs.existsSync('mb.json'));
            assert.deepEqual(JSON.parse(fs.readFileSync('mb.json')), imposters);
        }
        finally {
            fs.unlinkSync('mb.json');
        }
    });

    it('should work with mb replay', async function () {
        if (!host) {
            console.log('Skipping test: no non-localhost host found to bind to.');
            this.skip();
        }

        const originServerPort = mb.port + 1,
            originServerStub = { responses: [{ is: { body: 'ORIGIN' } }] },
            originServerRequest = { protocol: 'http', port: originServerPort, stubs: [originServerStub] },
            proxyPort = mb.port + 2,
            proxyDefinition = { to: `http://${host}:${originServerPort}`, mode: 'proxyAlways' },
            proxyStub = { responses: [{ proxy: proxyDefinition }] },
            proxyRequest = { protocol: 'http', port: proxyPort, stubs: [proxyStub] };
        await mb.start(['--host', host]);
        await mb.put('/imposters', { imposters: [originServerRequest, proxyRequest] });

        await http.responseFor({ method: 'GET', path: '/', hostname: host, port: proxyPort });
        await mb.replay(['--host', host]);
        const response = await mb.get('/imposters?replayable=true'),
            imposters = response.body.imposters,
            oldProxyImposter = imposters.find(imposter => imposter.port === proxyPort),
            responses = oldProxyImposter.stubs[0].responses;

        assert.strictEqual(responses.length, 1);
        assert.strictEqual(responses[0].is.body, 'ORIGIN');
    });

    it('should disallow localhost calls when bound to specific host', async function () {
        if (!host) {
            console.log('Skipping test: no non-localhost host found to bind to.');
            this.skip();
        }
        await mb.start(['--host', host]);

        try {
            await http.responseFor({ method: 'GET', path: '/', hostname: 'localhost', port: mb.port });
            assert.fail(`should not have connected (hostname: ${host})`);
        }
        catch (error) {
            // ECONNREFUSED is expected, but some OS/Node versions return ESOCKET
            assert.ok(['ECONNREFUSED', 'ESOCKET'].indexOf(error.code) >= 0, `Unexpected error code: ${error.code}`);
        }
    });

    it('should bind http imposter to provided host', async function () {
        if (!host) {
            console.log('Skipping test: no non-localhost host found to bind to.');
            this.skip();
        }
        const imposter = { protocol: 'http', port: mb.port + 1 };
        await mb.start(['--host', host]);
        await mb.post('/imposters', imposter);

        const hostCall = await http.responseFor({
            method: 'GET',
            path: '/',
            hostname: host,
            port: imposter.port
        });
        assert.strictEqual(hostCall.statusCode, 200);

        try {
            await http.responseFor({
                method: 'GET',
                path: '/',
                hostname: 'localhost',
                port: imposter.port
            });
            assert.fail('should not have connected to localhost');
        }
        catch (error) {
            // ECONNREFUSED is expected, but some OS/Node versions return ESOCKET
            assert.ok(['ECONNREFUSED', 'ESOCKET'].indexOf(error.code) >= 0, `Unexpected error code: ${error.code}`);
        }
    });

    it('should bind tcp imposter to provided host', async function () {
        if (!host) {
            console.log('Skipping test: no non-localhost host found to bind to.');
            this.skip();
        }
        const imposter = {
                protocol: 'tcp',
                port: mb.port + 1,
                stubs: [{ responses: [{ is: { data: 'OK' } }] }]
            },
            client = require('../api/tcp/tcpClient');
        await mb.start(['--host', host]);
        await mb.post('/imposters', imposter);

        const hostCall = await client.send('TEST', imposter.port, 0, host);
        assert.strictEqual(hostCall.toString(), 'OK');

        try {
            await client.send('TEST', imposter.port, 0, 'localhost');
            assert.fail('should not have connected to localhost');
        }
        catch (error) {
            // ECONNREFUSED is expected, but some OS/Node versions return ESOCKET
            assert.ok(['ECONNREFUSED', 'ESOCKET'].indexOf(error.code) >= 0, `Unexpected error code: ${error.code}`);
        }
    });

    it('should bind smtp imposter to provided host', async function () {
        if (!host) {
            console.log('Skipping test: no non-localhost host found to bind to.');
            this.skip();
        }
        const imposter = { protocol: 'smtp', port: mb.port + 1 },
            message = { from: '"From" <from@mb.org>', to: ['"To" <to@mb.org>'], subject: 'subject', text: 'text' },
            client = require('../api/smtp/smtpClient');
        await mb.start(['--host', host]);
        await mb.post('/imposters', imposter);

        await client.send(message, imposter.port, host);

        try {
            await client.send(message, imposter.port, 'localhost');
            assert.fail('should not have connected to localhost');
        }
        catch (error) {
            // ESOCKET in node v14, ECONNREFUSED before
            assert.ok(['ECONNREFUSED', 'ESOCKET'].indexOf(error.code) >= 0);
        }
    });
});