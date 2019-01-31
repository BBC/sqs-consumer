'use strict';

const SQS = require('aws-sdk/clients/sqs');
const { EventEmitter } = require('events');
const { SQSError, TimeoutError } = require('./errors');
const debug = require('debug')('sqs-consumer');

const auto = require('./bind');

const requiredOptions = [
  'queueUrl',
  'handleMessage'
];

function createTimeout(duration) {
  let timeout;
  const pending = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new TimeoutError()), duration);
  });
  return [timeout, pending];
}

function validate(options) {
  requiredOptions.forEach((option) => {
    if (!options[option]) {
      throw new Error('Missing SQS consumer option [' + option + '].');
    }
  });

  if (options.batchSize > 10 || options.batchSize < 1) {
    throw new Error('SQS batchSize option must be between 1 and 10.');
  }
}

function isAuthenticationError(err) {
  return (err.statusCode === 403 || err.code === 'CredentialsError');
}

function toSQSError(err, message) {
  const sqsError = new SQSError(message);
  sqsError.code = err.code;
  sqsError.statusCode = err.statusCode;
  sqsError.region = err.region;
  sqsError.retryable = err.retryable;
  sqsError.hostname = err.hostname;
  sqsError.time = err.time;

  return sqsError;
}

function hasMessages(response) {
  return response.Messages && response.Messages.length > 0;
}

class Consumer extends EventEmitter {
  constructor(options) {
    super();
    validate(options);

    this.queueUrl = options.queueUrl;
    this.handleMessage = options.handleMessage;
    this.handleMessageTimeout = options.handleMessageTimeout;
    this.attributeNames = options.attributeNames || [];
    this.messageAttributeNames = options.messageAttributeNames || [];
    this.stopped = true;
    this.batchSize = options.batchSize || 1;
    this.terminateVisibilityTimeout = options.terminateVisibilityTimeout || false;
    this.extendVisibilityTimeout = options.extendVisibilityTimeout || false;
    this.waitTimeSeconds = options.waitTimeSeconds || 20;
    this.authenticationErrorTimeout = options.authenticationErrorTimeout || 10000;

    this.sqs = options.sqs || new SQS({
      region: options.region || process.env.AWS_REGION || 'eu-west-1'
    });

    auto(this);
  }

  static create(options) {
    return new Consumer(options);
  }

  start() {
    if (this.stopped) {
      debug('Starting consumer');
      this.stopped = false;
      this._poll();
    }
  }

  stop() {
    debug('Stopping consumer');
    this.stopped = true;
  }

  async _poll() {
    if (this.stopped) {
      this.emit('stopped');
      return;
    }

    debug('Polling for messages');
    try {
      const receiveParams = {
        QueueUrl: this.queueUrl,
        AttributeNames: this.attributeNames,
        MessageAttributeNames: this.messageAttributeNames,
        MaxNumberOfMessages: this.batchSize,
        WaitTimeSeconds: this.waitTimeSeconds,
        VisibilityTimeout: this.visibilityTimeout
      };

      const response = await this._receiveMessage(receiveParams);

      const visTimeoutParams = {
        QueueUrl: this.queueUrl,
        AttributeNames: ['VisibilityTimeout']
      };

      const visTimeoutResponse = await this.sqs.getQueueAttributes(visTimeoutParams).promise();
      this.visibilityTimeout = visTimeoutResponse['Attributes']['VisibilityTimeout'];

      this._handleSqsResponse(response);

    } catch (err) {
      this.emit('error', err);
      if (isAuthenticationError(err)) {
        debug('There was an authentication error. Pausing before retrying.');
        return setTimeout(() => this._poll(), this.authenticationErrorTimeout);
      }
    }
  }

  async _handleSqsResponse(response) {
    debug('Received SQS response');
    debug(response);

    if (response) {
      if (hasMessages(response)) {
        await Promise.all(response.Messages.map(this._processMessage));
        this.emit('response_processed');
      } else {
        this.emit('empty');
      }
    }

    this._poll();
  }

  async _processMessage(message) {
    this.emit('message_received', message);

    try {
      await this._executeHandler(message);
      await this._deleteMessage(message);
      this.emit('message_processed', message);
    } catch (err) {
      if (err.name === SQSError.name) {
        this.emit('error', err, message);
      } else if (err instanceof TimeoutError) {
        this.emit('timeout_error', err, message);
      } else {
        this.emit('processing_error', err, message);
      }

      if (this.terminateVisibilityTimeout) {
        try {
          await this._terminateVisabilityTimeout(message);
        } catch (err) {
          this.emit('error', err, message);
        }
      }
    }
  }

  async _receiveMessage(params) {
    try {
      return await this.sqs.receiveMessage(params).promise();
    } catch (err) {
      throw toSQSError(err, `SQS receive message failed: ${err.message}`);
    }
  }

  async _terminateVisabilityTimeout(message) {
    return this.sqs
      .changeMessageVisibility({
        QueueUrl: this.queueUrl,
        ReceiptHandle: message.ReceiptHandle,
        VisibilityTimeout: 0
      })
      .promise();
  }

  async _deleteMessage(message) {
    debug('Deleting message %s', message.MessageId);

    const deleteParams = {
      QueueUrl: this.queueUrl,
      ReceiptHandle: message.ReceiptHandle
    };

    try {
      await this.sqs.deleteMessage(deleteParams).promise();
    } catch (err) {
      throw toSQSError(err, `SQS delete message failed: ${err.message}`);
    }
  }

  extendTimeout(message) {
    if (message.finishedProcessing !== true) {
      message.visibilityTimeout = (message.visibilityTimeout * 2);
      const boundExtendTimeout = this.extendTimeout.bind(this, message);
      this.sqs
        .changeMessageVisibility({
          QueueUrl: this.queueUrl,
          ReceiptHandle: message.ReceiptHandle,
          VisibilityTimeout: message.visibilityTimeout
        }).promise().then((err) => {
          if (err) {
            debug(err);
          }
          setTimeout(boundExtendTimeout, (message.visibilityTimeout * 450));
        });
    }
  }

  async _executeHandler(message) {
    let timeout;
    let pending;
    try {
      message.finishedProcessing = false;
      message.visibilityTimeout = this.visibilityTimeout;
      if (this.extendVisibilityTimeout) {
        const boundExtendTimeout = this.extendTimeout.bind(this, message);
        boundExtendTimeout();
      }

      if (this.handleMessageTimeout) {
        [timeout, pending] = createTimeout(this.handleMessageTimeout);
        await Promise.race([
          this.handleMessage(message),
          pending
        ]);
      } else {
        await this.handleMessage(message);
      }
    } catch (err) {
      if (err instanceof TimeoutError) {
        err.message = `Message handler timed out after ${this.handleMessageTimeout}ms: ${err.message}`;
        message.finishedProcessing = true;
      } else {
        err.message = `Unexpected message handler failure: ${err.message}`;
        message.finishedProcessing = true;
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }
}

module.exports = Consumer;
