'use strict';

console.log('Loading function');
var https = require('https');
const aws = require('aws-sdk');
var zlib = require('zlib');
var crypto = require('crypto');

const s3 = new aws.S3({ apiVersion: '2006-03-01' });

var endpoint = '//Add the Elasticsearch endpoint here';

exports.handler = (event, context, callback) => {

    // Get the object from the event and show its content type
    const bucket = event.Records[0].s3.bucket.name;
    console.log('The name of bucket is:', bucket);
    const key = decodeURIComponent(event.Records[0].s3.object.key.replace(/\+/g, ' '));
    console.log('The name of key is:', key);

    const params = {
        Bucket: bucket,
        Key: key,
    };
    s3.getObject(params, (err, data) => {
        if (err) {
            console.log(err);
            const message = `Error getting object ${key} from bucket ${bucket}. Make sure they exist and your bucket is in the same region as this function.`;
            console.log(message);
            callback(message);
        } else {
            console.log('CONTENT TYPE:', data.ContentType);
            console.log('Reading the S3 data:');
            zlib.gunzip(data.Body, function (error, buffer){
                if (error) {
                    console.log('erorr uncompressing the data:', error);
                } else {
                    var awslogsData = buffer.toString('ascii');

                    var elasticsearchBulkData = transform(awslogsData, bucket, key);
                    
                     // skip control messages
                    if (!elasticsearchBulkData) {
                        console.log('Received a control message');
                        context.succeed('Control message handled successfully');
                        return;
                    }
                    // post documents to the Amazon Elasticsearch Service
                    post(elasticsearchBulkData, function(error, success, statusCode, failedItems) {
                        console.log('Response: ' + JSON.stringify({ 
                            "statusCode": statusCode 
                        }));

                        if (error) { 
                            console.log('Error: ' + JSON.stringify(error, null, 2));

                            if (failedItems && failedItems.length > 0) {
                                console.log("Failed Items: " +
                                JSON.stringify(failedItems, null, 2));
                            }

                            context.fail(JSON.stringify(error));
                        } else {
                            console.log('Success: ' + JSON.stringify(success));
                            context.succeed('Success');
                        }
                    });
                }
            });
            callback(null, data.ContentType);
        }
    });
};

function transform(payload, bucket, key) {
    if (payload.messageType === 'CONTROL_MESSAGE') {
        return null;
    }
    var bulkRequestBody = '';
    
    var splitLines = payload.split("\n"); // does not handle multiline at all - need a little love to get that to work
    var timestampRe = /^(\d\d\d\d-\d\d-\d\dT\d\d:\d\d:\d\d).\d\d\dZ\s(.*)/;
    var keyRe = /^([^\/]+)\/[^\/]+\/([^\/]+)\//;
    var keyParts = key.match(keyRe);
    var logStream = keyParts[2];
    splitLines.forEach(function(line) {
        var parts = line.match(timestampRe);
        //console.log(parts);
        if(!parts) {
            console.log("BAD LINE: ", line);
            return;
        }
        var timestamp = new Date(parts[1]);
        var id = guid();

        // index name format: cwl-YYYY.MM.DD
        var indexName = [
            'cwl-' + timestamp.getUTCFullYear(),              // year
            ('0' + (timestamp.getUTCMonth() + 1)).slice(-2),  // month
            ('0' + timestamp.getUTCDate()).slice(-2)          // day
        ].join('.');
        var message = parts[2];

        var source = buildSource(message, {});
        source['@id'] = id;
        source['@timestamp'] = new Date(1 * timestamp).toISOString();
        source['@message'] = message;
        source['@owner'] = payload.owner;
        source['@log_group'] = bucket;
        source['@log_stream'] = logStream;

        var action = { "index": {} };
        action.index._index = indexName;
        action.index._type = bucket;
        action.index._id = id;

        bulkRequestBody += [ 
            JSON.stringify(action), 
            JSON.stringify(source),
        ].join('\n') + '\n';
    });
    
    console.log('Request body is:',bulkRequestBody);
    return bulkRequestBody;
}

function buildSource(message, extractedFields) {
    if (extractedFields) {
        var source = {};

        for (var key in extractedFields) {
            if (extractedFields.hasOwnProperty(key) && extractedFields[key]) {
                var value = extractedFields[key];

                if (isNumeric(value)) {
                    source[key] = 1 * value;
                    continue;
                }

                var jsonSubString = extractJson(value);
                if (jsonSubString !== null) {
                    source['$' + key] = JSON.parse(jsonSubString);
                }

                source[key] = value;
            }
        }
        return source;
    }

    jsonSubString = extractJson(message);
    if (jsonSubString !== null) { 
        return JSON.parse(jsonSubString); 
    }

    return {};
}

function extractJson(message) {
    var jsonStart = message.indexOf('{');
    if (jsonStart < 0) return null;
    var jsonSubString = message.substring(jsonStart);
    return isValidJson(jsonSubString) ? jsonSubString : null;
}

function isValidJson(message) {
    try {
        JSON.parse(message);
    } catch (e) { return false; }
    return true;
}

function isNumeric(n) {
    return !isNaN(parseFloat(n)) && isFinite(n);
}

function post(body, callback) {
    var requestParams = buildRequest(endpoint, body);

    var request = https.request(requestParams, function(response) {
        var responseBody = '';
        response.on('data', function(chunk) {
            responseBody += chunk;
        });
        response.on('end', function() {
            var info = JSON.parse(responseBody);
            var failedItems;
            var success;
            
            if (response.statusCode >= 200 && response.statusCode < 299) {
                failedItems = info.items.filter(function(x) {
                    return x.index.status >= 300;
                });

                success = { 
                    "attemptedItems": info.items.length,
                    "successfulItems": info.items.length - failedItems.length,
                    "failedItems": failedItems.length
                };
            }

            var error = response.statusCode !== 200 || info.errors === true ? {
                "statusCode": response.statusCode,
                "responseBody": responseBody
            } : null;

            callback(error, success, response.statusCode, failedItems);
        });
    }).on('error', function(e) {
        callback(e);
    });
    request.end(requestParams.body);
}

function buildRequest(endpoint, body) {
    var endpointParts = endpoint.match(/^([^\.]+)\.?([^\.]*)\.?([^\.]*)\.amazonaws\.com$/);
    var region = endpointParts[2];
    var service = endpointParts[3];
    var datetime = (new Date()).toISOString().replace(/[:\-]|\.\d{3}/g, '');
    var date = datetime.substr(0, 8);
    var kDate = hmac('AWS4' + process.env.AWS_SECRET_ACCESS_KEY, date);
    var kRegion = hmac(kDate, region);
    var kService = hmac(kRegion, service);
    var kSigning = hmac(kService, 'aws4_request');
    
    var request = {
        host: endpoint,
        method: 'POST',
        path: '/_bulk',
        body: body,
        headers: { 
            'Content-Type': 'application/json',
            'Host': endpoint,
            'Content-Length': Buffer.byteLength(body),
            'X-Amz-Security-Token': process.env.AWS_SESSION_TOKEN,
            'X-Amz-Date': datetime
        }
    };

    var canonicalHeaders = Object.keys(request.headers)
        .sort(function(a, b) { return a.toLowerCase() < b.toLowerCase() ? -1 : 1; })
        .map(function(k) { return k.toLowerCase() + ':' + request.headers[k]; })
        .join('\n');

    var signedHeaders = Object.keys(request.headers)
        .map(function(k) { return k.toLowerCase(); })
        .sort()
        .join(';');

    var canonicalString = [
        request.method,
        request.path, '',
        canonicalHeaders, '',
        signedHeaders,
        hash(request.body, 'hex'),
    ].join('\n');

    var credentialString = [ date, region, service, 'aws4_request' ].join('/');

    var stringToSign = [
        'AWS4-HMAC-SHA256',
        datetime,
        credentialString,
        hash(canonicalString, 'hex')
    ] .join('\n');

    request.headers.Authorization = [
        'AWS4-HMAC-SHA256 Credential=' + process.env.AWS_ACCESS_KEY_ID + '/' + credentialString,
        'SignedHeaders=' + signedHeaders,
        'Signature=' + hmac(kSigning, stringToSign, 'hex')
    ].join(', ');

    return request;
}

function hmac(key, str, encoding) {
    return crypto.createHmac('sha256', key).update(str, 'utf8').digest(encoding);
}

function hash(str, encoding) {
    return crypto.createHash('sha256').update(str, 'utf8').digest(encoding);
}

function guid() {
  function s4() {
    return Math.floor((1 + Math.random()) * 0x10000)
      .toString(16)
      .substring(1);
  }
  return s4() + s4() + '-' + s4() + '-' + s4() + '-' +
    s4() + '-' + s4() + s4() + s4();
}
 