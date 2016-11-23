# Cloudwatch Logs Analyze data

### Package cloudwatch-logs-analyze-logs

Copyright 2016- Amazon.com, Inc. or its affiliates. All Rights Reserved.

## Introduction

You want to do analysis on log data using Elasticsearch but don't want to leave it running all the time. You don't want to deal with ongoing scalability and operations. And you need to build the Elasticsearch cluster from historical data. The **CloudWatch Logs Analyze Logs** is a Lambda function that helps in reading the logs from S3 (once logs in a specific timeframe are exported from CloudWatch Logs) and post those logs to Elasticsearch.

## Flow of Events

![Flow of events](https://s3.amazonaws.com/aws-cloudwatch/downloads/cloudwatch-logs-analyze-data/demo-3.png)

## Setup Overview

Lambda function is written in Node.js. Since we don't have a dependency on a specific version of library, we rely on the defaults provided by Lambda. Correspondingly a Lambda deployment package is not required. Instead we can use the inline editor in Lambda. You can create a new Lambda function, and copy the code in index.js from this repository to your function. You need to add the Elasticsearch endpoint. See 'Configurable parameters' section below.  

### Pre-requisite

* S3 bucket where the logs from CloudWatch Logs will be exported to.
* An Elasticsearch domain, where you want to post your logs for analysis.

### Triggers

* The Lambda function is triggered at a S3 'ObjectCreated' event type.
* You need to provide the S3 bucket on which the event will be triggered.

### Authorization

Since there is a need here for various AWS services making calls to each other, appropriate authorization is required.  This takes the form of configuring an IAM role, to which various authorization policies are attached.  This role will be assumed by the Lambda function when running. The below two permissions are required:
 
1.S3 permits Lambda to fetch the created objects from a given bucket

```json
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Action": [
                "s3:GetObject"
            ],
            "Resource": "arn:aws:s3:::*"
        }
    ]
}
```

2.Elasticsearch permits Lambda to post logs into the domain. The below policy allows open access to the Elasticsearch domain. But it is recommended that you only allow access to specific accounts or users or IPs. 

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "AWS": [
          "*"
        ]
      },
      "Action": [
        "es:*"
      ],
      "Resource": "arn:aws:es:us-west-2:{account-id}:domain/{domain-name}/*"
    }
  ]
}
```

### Lambda Function

***Configurable parameters:***

* **Elasticsearch endpoint**: In the Lambda function, there is a variable called as 'endpoint'. You need to specific the endpoint of your Elasticsearch domain.

***Instructions:***

* Handler: The name of the main code file. In this example, we have used index as the name of the handler.
* You export logs from a LogGroup in a specific timeframe from CloudWatch Logs. Export can be done via the SDK, CLI or Console.
* The Lambda function reads the log data from the S3 object using the S3 getObject API. The data is encoded and compressed.
* The Lambda function decodes and decompresses the data using the zlib library.
* The data is then send to Elasticsearch by putting to its HTTP endpoint.
* You can now create an index and start using Kibana. Once the index pattern is configured, you can Discover, Visualize and Interact with your log data.

### Lambda Configuration

This Lambda function was created with runtime Node.js 4.3. It has been tested with 512 MB and 3 minutes timeout. No VPC was used. You can change the configuration based on your testing.
