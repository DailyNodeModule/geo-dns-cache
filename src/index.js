const path = require('path');
const dgram = require('dgram');
const { MongoClient } = require('mongodb');
const fs = require('fs-extra');
const dnsPacket = require('dns-packet');
const geoip = require('geoip-lite');

(async () => {
    const config = JSON.parse(await fs.readFile(path.join(__dirname, 'config.json'), 'utf8'));
    const mongo = await MongoClient.connect(process.env.MONGO_URL || 'mongodb://localhost:27017', { useNewUrlParser: true });
    const db = mongo.db('geo-dns-cache');
    const servers = db.collection('dnsServers');
    const cache = db.collection('cache');

    await servers.createIndex({ lnglat : "2dsphere" });
    await servers.createIndex({ ip: 1 }, { unique: true, dropDups: true });
    await cache.createIndex({ 
        'question.class': 1, 
        'question.name': 1, 
        'question.type': 1
            // Cached records expire after 24 hours.
    }, { expireAfterSeconds: 86400 });

    // Here we grab the location of each of our servers, and add the information to the database.
    for (let i = 0; i < config.servers.length; i++) {
        const srv = config.servers[i];

        const { ip, port } = srv;
        await servers.updateOne({ ip }, {
            $set: {
                ip,
                port,
                lnglat: {
                    type: 'Point',
                    coordinates: geoip.lookup(ip).ll.reverse()
                },
                ranking: i
            }
        }, { upsert: true });
    }

    const dnsServer = dgram.createSocket('udp4');

    // This function will try and find the closest DNS Server to the incoming IP Address. If the location of the incoming IP Address cannot be determined it chooses the server highest in the numerical order.
    async function findBestDNSServer(ipAddressOfClient) {
        let mongoQuery;
        const geo = geoip.lookup(ipAddressOfClient);

        if (geo)
            mongoQuery = { lnglat: { $nearSphere: geo.ll.reverse() } };
        else 
            mongoQuery = {};

        let cursor = await servers.find(mongoQuery).limit(1);

        if (!geo) {
            cursor.sort({ speedRanking: -1 });
        }

        return await cursor.next();
    }

    dnsServer.on('message', async (rawIncomingMessage, info) => {
        const bestServer = await findBestDNSServer(info.address);

        // Using DNS packet you can decode/encode DNS requests.
        const incomingMessage = dnsPacket.decode(rawIncomingMessage);

        let answers = [];
        
        // For each question we'll check the database to see if an answer already exists before requesting an answer from an external server.
        for (const question of incomingMessage.questions) {
            let resp = (await cache.find({ 
                'question.class': question.class, 
                'question.type': question.type, 
                'question.name': question.name 
            }, { answer: 1, _id: 0 })
                .toArray())
                .map((d) => d.answer);

            // If no cached records are found, we'll request an answer from the server and store the result in the cache.
            if (!resp.length) {
                let serverInfo = bestServer;
            
                const outboundSocket = dgram.createSocket('udp4');
                outboundSocket.send(dnsPacket.encode({
                    type: 'query',
                    questions: [
                        question
                    ]
                }), serverInfo.port, serverInfo.ip);

                const outboundResponse = await new Promise((resolve, reject) => {
                    outboundSocket.once('message', (message) => { resolve(message); });
                    outboundSocket.once('error', (error) => reject(error));
                });

                const decodedOutboundResponse = dnsPacket.decode(outboundResponse);
                const { answers } = decodedOutboundResponse;

                if (answers.length) {
                    await cache.insertMany(answers.map((answer) => {
                        return {
                            question,
                            answer
                        };
                    }));
                }

                resp = decodedOutboundResponse.answers;
            }

            Array.prototype.push.apply(answers, resp);
        }
        
        const resp = dnsPacket.encode({
            type: 'response',
            answers,
            id: incomingMessage.id
        });

        dnsServer.send(resp, info.port, info.address);
    });

    const port = Number(process.env.PORT) || 3053;

    dnsServer.bind(port, () => {
        console.log(`listening on ${port}`);
    });
})();