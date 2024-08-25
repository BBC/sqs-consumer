import * as SQS from 'aws-sdk/clients/sqs';
import { EventEmitter } from 'events';
declare type SQSMessage = SQS.Types.Message;
export interface ConsumerOptions {
    queueUrl?: string;
    attributeNames?: string[];
    messageAttributeNames?: string[];
    stopped?: boolean;
    concurrencyLimit?: number;
    batchSize?: number;
    visibilityTimeout?: number;
    waitTimeSeconds?: number;
    authenticationErrorTimeout?: number;
    pollingWaitTimeMs?: number;
    msDelayOnEmptyBatchSize?: number;
    terminateVisibilityTimeout?: boolean;
    sqs?: SQS;
    region?: string;
    handleMessageTimeout?: number;
    handleMessage?(message: SQSMessage): Promise<void>;
    handleMessageBatch?(messages: SQSMessage[], consumer: Consumer): Promise<void>;
    pollingStartedInstrumentCallback?(eventData: object): void;
    pollingFinishedInstrumentCallback?(eventData: object): void;
    batchStartedInstrumentCallBack?(eventData: object): void;
    batchFinishedInstrumentCallBack?(eventData: object): void;
    batchFailedInstrumentCallBack?(eventData: object): void;
}
export declare class Consumer extends EventEmitter {
    private queueUrl;
    private handleMessage;
    private handleMessageBatch;
    private pollingStartedInstrumentCallback?;
    private pollingFinishedInstrumentCallback?;
    private batchStartedInstrumentCallBack?;
    private batchFinishedInstrumentCallBack?;
    private batchFailedInstrumentCallBack?;
    private handleMessageTimeout;
    private attributeNames;
    private messageAttributeNames;
    private stopped;
    private concurrencyLimit;
    private freeConcurrentSlots;
    private batchSize;
    private visibilityTimeout;
    private waitTimeSeconds;
    private authenticationErrorTimeout;
    private pollingWaitTimeMs;
    private msDelayOnEmptyBatchSize;
    private terminateVisibilityTimeout;
    private sqs;
    constructor(options: ConsumerOptions);
    readonly isRunning: boolean;
    static create(options: ConsumerOptions): Consumer;
    start(): void;
    stop(): void;
    setBatchSize(newBatchSize: number): void;
    setConcurrencyLimit(newConcurrencyLimit: number): void;
    setPollingWaitTimeMs(newPollingWaitTimeMs: number): void;
    reportMessageFromBatchFinished(message: SQSMessage, error?: Error): Promise<void>;
    private reportNumberOfMessagesReceived;
    private handleSqsResponse;
    private processMessage;
    private receiveMessage;
    private deleteMessage;
    private executeHandler;
    private terminateVisabilityTimeout;
    private emitError;
    private poll;
    private processMessageBatch;
}
export {};
