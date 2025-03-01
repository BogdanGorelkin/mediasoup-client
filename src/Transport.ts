import { AwaitQueue } from 'awaitqueue';
import queueMicrotask from 'queue-microtask';
import { Logger } from './Logger';
import { EnhancedEventEmitter } from './EnhancedEventEmitter';
import { UnsupportedError, InvalidStateError } from './errors';
import * as utils from './utils';
import * as ortc from './ortc';
import { HandlerFactory, HandlerInterface, HandlerReceiveOptions } from './handlers/HandlerInterface';
import { Producer, ProducerOptions } from './Producer';
import { Consumer, ConsumerOptions } from './Consumer';
import { DataProducer, DataProducerOptions } from './DataProducer';
import { DataConsumer, DataConsumerOptions } from './DataConsumer';
import { RtpParameters, MediaKind } from './RtpParameters';
import { SctpParameters, SctpStreamParameters } from './SctpParameters';
import { AppData } from './types';

const logger = new Logger('Transport');

export type TransportOptions<TransportAppData extends AppData = AppData> =
{
	id: string;
	iceParameters: IceParameters;
	iceCandidates: IceCandidate[];
	dtlsParameters: DtlsParameters;
	sctpParameters?: SctpParameters;
	iceServers?: RTCIceServer[];
	iceTransportPolicy?: RTCIceTransportPolicy;
	additionalSettings?: any;
	proprietaryConstraints?: any;
	appData?: TransportAppData;
};

export type CanProduceByKind =
{
	audio: boolean;
	video: boolean;
	[key: string]: boolean;
};

export type IceParameters =
{
	/**
	 * ICE username fragment.
	 * */
	usernameFragment: string;
	/**
	 * ICE password.
	 */
	password: string;
	/**
	 * ICE Lite.
	 */
	iceLite?: boolean;
};

export type IceCandidate =
{
	/**
	 * Unique identifier that allows ICE to correlate candidates that appear on
	 * multiple transports.
	 */
	foundation: string;
	/**
	 * The assigned priority of the candidate.
	 */
	priority: number;
	/**
	 * The IP address of the candidate.
	 */
	ip: string;
	/**
	 * The protocol of the candidate.
	 */
	protocol: 'udp' | 'tcp';
	/**
	 * The port for the candidate.
	 */
	port: number;
	/**
	 * The type of candidate.
	 */
	type: 'host' | 'srflx' | 'prflx' | 'relay';
	/**
	 * The type of TCP candidate.
	 */
	tcpType?: 'active' | 'passive' | 'so';
};

export type DtlsParameters =
{
	/**
	 * Server DTLS role. Default 'auto'.
	 */
	role?: DtlsRole;
	/**
	 * Server DTLS fingerprints.
	 */
	fingerprints: DtlsFingerprint[];
};

/**
 * The hash function algorithm (as defined in the "Hash function Textual Names"
 * registry initially specified in RFC 4572 Section 8) and its corresponding
 * certificate fingerprint value (in lowercase hex string as expressed utilizing
 * the syntax of "fingerprint" in RFC 4572 Section 5).
 */
export type DtlsFingerprint =
{
	algorithm: string;
	value: string;
};

export type DtlsRole = 'auto' | 'client' | 'server';

export type IceGatheringState =
	| 'new'
	| 'gathering'
	| 'complete';

export type ConnectionState =
	| 'new'
	| 'connecting'
	| 'connected'
	| 'failed'
	| 'disconnected'
	| 'closed';

export type PlainRtpParameters =
{
	ip: string;
	ipVersion: 4 | 6;
	port: number;
};

export type TransportEvents =
{
	connect: [{ dtlsParameters: DtlsParameters }, () => void, (error: Error) => void];
	icegatheringstatechange: [IceGatheringState];
	connectionstatechange: [ConnectionState];
	produce:
	[
		{
			kind: MediaKind;
			rtpParameters: RtpParameters;
			appData: AppData;
		},
		({ id }: { id: string }) => void,
		(error: Error) => void
	];
	producedata:
	[
		{
			sctpStreamParameters: SctpStreamParameters;
			label?: string;
			protocol?: string;
			appData: AppData;
		},
		({ id }: { id: string }) => void,
		(error: Error) => void
	];
};

export type TransportObserverEvents =
{
	close: [];
	newproducer: [Producer];
	newconsumer: [Consumer];
	newdataproducer: [DataProducer];
	newdataconsumer: [DataConsumer];
};

class ConsumerCreationTask
{
	consumerOptions: ConsumerOptions;
	promise: Promise<Consumer>;
	resolve?: (consumer: Consumer) => void;
	reject?: (error: Error) => void;

	constructor(consumerOptions: ConsumerOptions)
	{
		this.consumerOptions = consumerOptions;
		this.promise = new Promise((resolve, reject) =>
		{
			this.resolve = resolve;
			this.reject = reject;
		});
	}
}

export class Transport<TransportAppData extends AppData = AppData>
	extends EnhancedEventEmitter<TransportEvents>
{
	// Id.
	private readonly _id: string;
	// Closed flag.
	private _closed = false;
	// Direction.
	private readonly _direction: 'send' | 'recv';
	// Extended RTP capabilities.
	private readonly _extendedRtpCapabilities: any;
	// Whether we can produce audio/video based on computed extended RTP
	// capabilities.
	private readonly _canProduceByKind: CanProduceByKind;
	// SCTP max message size if enabled, null otherwise.
	private readonly _maxSctpMessageSize?: number | null;
	// RTC handler isntance.
	private readonly _handler: HandlerInterface;
	// Transport ICE gathering state.
	private _iceGatheringState: IceGatheringState = 'new';
	// Transport connection state.
	private _connectionState: ConnectionState = 'new';
	// App custom data.
	private _appData: TransportAppData;
	// Map of Producers indexed by id.
	private readonly _producers: Map<string, Producer> = new Map();
	// Map of Consumers indexed by id.
	private readonly _consumers: Map<string, Consumer> = new Map();
	// Map of DataProducers indexed by id.
	private readonly _dataProducers: Map<string, DataProducer> = new Map();
	// Map of DataConsumers indexed by id.
	private readonly _dataConsumers: Map<string, DataConsumer> = new Map();
	// Whether the Consumer for RTP probation has been created.
	private _probatorConsumerCreated = false;
	// AwaitQueue instance to make async tasks happen sequentially.
	private readonly _awaitQueue = new AwaitQueue();
	// Consumer creation tasks awaiting to be processed.
	private _pendingConsumerTasks: ConsumerCreationTask[] = [];
	// Consumer creation in progress flag.
	private _consumerCreationInProgress = false;
	// Consumers pending to be paused.
	private _pendingPauseConsumers: Map<string, Consumer> = new Map();
	// Consumer pause in progress flag.
	private _consumerPauseInProgress = false;
	// Consumers pending to be resumed.
	private _pendingResumeConsumers: Map<string, Consumer> = new Map();
	// Consumer resume in progress flag.
	private _consumerResumeInProgress = false;
	// Consumers pending to be closed.
	private _pendingCloseConsumers: Map<string, Consumer> = new Map();
	// Consumer close in progress flag.
	private _consumerCloseInProgress = false;
	// Observer instance.
	protected readonly _observer = new EnhancedEventEmitter<TransportObserverEvents>();

	constructor(
		{
			direction,
			id,
			iceParameters,
			iceCandidates,
			dtlsParameters,
			sctpParameters,
			iceServers,
			iceTransportPolicy,
			additionalSettings,
			proprietaryConstraints,
			appData,
			handlerFactory,
			extendedRtpCapabilities,
			canProduceByKind
		}:
		{
			direction: 'send' | 'recv';
			handlerFactory: HandlerFactory;
			extendedRtpCapabilities: any;
			canProduceByKind: CanProduceByKind;
		} & TransportOptions<TransportAppData>
	)
	{
		super();

		logger.debug('constructor() [id:%s, direction:%s]', id, direction);

		this._id = id;
		this._direction = direction;
		this._extendedRtpCapabilities = extendedRtpCapabilities;
		this._canProduceByKind = canProduceByKind;
		this._maxSctpMessageSize =
			sctpParameters ? sctpParameters.maxMessageSize : null;

		// Clone and sanitize additionalSettings.
		additionalSettings = utils.clone(additionalSettings, {});

		delete additionalSettings.iceServers;
		delete additionalSettings.iceTransportPolicy;
		delete additionalSettings.bundlePolicy;
		delete additionalSettings.rtcpMuxPolicy;
		delete additionalSettings.sdpSemantics;

		this._handler = handlerFactory();

		this._handler.run(
			{
				direction,
				iceParameters,
				iceCandidates,
				dtlsParameters,
				sctpParameters,
				iceServers,
				iceTransportPolicy,
				additionalSettings,
				proprietaryConstraints,
				extendedRtpCapabilities
			});

		this._appData = appData || {} as TransportAppData;

		this.handleHandler();
	}

	/**
	 * Transport id.
	 */
	get id(): string
	{
		return this._id;
	}

	/**
	 * Whether the Transport is closed.
	 */
	get closed(): boolean
	{
		return this._closed;
	}

	/**
	 * Transport direction.
	 */
	get direction(): 'send' | 'recv'
	{
		return this._direction;
	}

	/**
	 * RTC handler instance.
	 */
	get handler(): HandlerInterface
	{
		return this._handler;
	}

	/**
	 * ICE gathering state.
	 */
	get iceGatheringState(): IceGatheringState
	{
		return this._iceGatheringState;
	}

	/**
	 * Connection state.
	 */
	get connectionState(): ConnectionState
	{
		return this._connectionState;
	}

	/**
	 * App custom data.
	 */
	get appData(): TransportAppData
	{
		return this._appData;
	}

	/**
	 * App custom data setter.
	 */
	set appData(appData: TransportAppData)
	{
		this._appData = appData;
	}

	get observer(): EnhancedEventEmitter
	{
		return this._observer;
	}

	/**
	 * Close the Transport.
	 */
	close(): void
	{
		if (this._closed)
		{
			return;
		}

		logger.debug('close()');

		this._closed = true;

		// Stop the AwaitQueue.
		this._awaitQueue.stop();

		// Close the handler.
		this._handler.close();

		// Change connection state to 'closed' since the handler may not emit
		// '@connectionstatechange' event.
		this._connectionState = 'closed';

		// Close all Producers.
		for (const producer of this._producers.values())
		{
			producer.transportClosed();
		}
		this._producers.clear();

		// Close all Consumers.
		for (const consumer of this._consumers.values())
		{
			consumer.transportClosed();
		}
		this._consumers.clear();

		// Close all DataProducers.
		for (const dataProducer of this._dataProducers.values())
		{
			dataProducer.transportClosed();
		}
		this._dataProducers.clear();

		// Close all DataConsumers.
		for (const dataConsumer of this._dataConsumers.values())
		{
			dataConsumer.transportClosed();
		}
		this._dataConsumers.clear();

		// Emit observer event.
		this._observer.safeEmit('close');
	}

	/**
	 * Get associated Transport (RTCPeerConnection) stats.
	 *
	 * @returns {RTCStatsReport}
	 */
	async getStats(): Promise<RTCStatsReport>
	{
		if (this._closed)
		{
			throw new InvalidStateError('closed');
		}

		return this._handler.getTransportStats();
	}

	/**
	 * Restart ICE connection.
	 */
	async restartIce(
		{ iceParameters }:
		{ iceParameters: IceParameters }
	): Promise<void>
	{
		logger.debug('restartIce()');

		if (this._closed)
		{
			throw new InvalidStateError('closed');
		}
		else if (!iceParameters)
		{
			throw new TypeError('missing iceParameters');
		}

		// Enqueue command.
		return this._awaitQueue.push(
			async () => await this._handler.restartIce(iceParameters),
			'transport.restartIce()');
	}

	/**
	 * Update ICE servers.
	 */
	async updateIceServers(
		{ iceServers }:
		{ iceServers?: RTCIceServer[] } = {}
	): Promise<void>
	{
		logger.debug('updateIceServers()');

		if (this._closed)
		{
			throw new InvalidStateError('closed');
		}
		else if (!Array.isArray(iceServers))
		{
			throw new TypeError('missing iceServers');
		}

		// Enqueue command.
		return this._awaitQueue.push(
			async () => this._handler.updateIceServers(iceServers),
			'transport.updateIceServers()');
	}

	/**
	 * Create a Producer.
	 */
	async produce<ProducerAppData extends AppData = AppData>(
		{
			track,
			encodings,
			codecOptions,
			codec,
			stopTracks = true,
			disableTrackOnPause = true,
			zeroRtpOnPause = false,
			appData = {} as ProducerAppData
		}: ProducerOptions<ProducerAppData> = {}
	): Promise<Producer<ProducerAppData>>
	{
		logger.debug('produce() [track:%o]', track);

		if (this._closed)
		{
			throw new InvalidStateError('closed');
		}
		else if (!track)
		{
			throw new TypeError('missing track');
		}
		else if (this._direction !== 'send')
		{
			throw new UnsupportedError('not a sending Transport');
		}
		else if (!this._canProduceByKind[track.kind])
		{
			throw new UnsupportedError(`cannot produce ${track.kind}`);
		}
		else if (track.readyState === 'ended')
		{
			throw new InvalidStateError('track ended');
		}
		else if (this.listenerCount('connect') === 0 && this._connectionState === 'new')
		{
			throw new TypeError('no "connect" listener set into this transport');
		}
		else if (this.listenerCount('produce') === 0)
		{
			throw new TypeError('no "produce" listener set into this transport');
		}
		else if (appData && typeof appData !== 'object')
		{
			throw new TypeError('if given, appData must be an object');
		}

		// Enqueue command.
		return this._awaitQueue.push(
			async () =>
			{
				let normalizedEncodings;

				if (encodings && !Array.isArray(encodings))
				{
					throw TypeError('encodings must be an array');
				}
				else if (encodings && encodings.length === 0)
				{
					normalizedEncodings = undefined;
				}
				else if (encodings)
				{
					normalizedEncodings = encodings
						.map((encoding: any) =>
						{
							const normalizedEncoding: any = { active: true };

							if (encoding.active === false)
							{
								normalizedEncoding.active = false;
							}
							if (typeof encoding.dtx === 'boolean')
							{
								normalizedEncoding.dtx = encoding.dtx;
							}
							if (typeof encoding.scalabilityMode === 'string')
							{
								normalizedEncoding.scalabilityMode = encoding.scalabilityMode;
							}
							if (typeof encoding.scaleResolutionDownBy === 'number')
							{
								normalizedEncoding.scaleResolutionDownBy = encoding.scaleResolutionDownBy;
							}
							if (typeof encoding.maxBitrate === 'number')
							{
								normalizedEncoding.maxBitrate = encoding.maxBitrate;
							}
							if (typeof encoding.maxFramerate === 'number')
							{
								normalizedEncoding.maxFramerate = encoding.maxFramerate;
							}
							if (typeof encoding.adaptivePtime === 'boolean')
							{
								normalizedEncoding.adaptivePtime = encoding.adaptivePtime;
							}
							if (typeof encoding.priority === 'string')
							{
								normalizedEncoding.priority = encoding.priority;
							}
							if (typeof encoding.networkPriority === 'string')
							{
								normalizedEncoding.networkPriority = encoding.networkPriority;
							}

							return normalizedEncoding;
						});
				}

				const { localId, rtpParameters, rtpSender } = await this._handler.send(
					{
						track,
						encodings : normalizedEncodings,
						codecOptions,
						codec
					});

				try
				{
					// This will fill rtpParameters's missing fields with default values.
					ortc.validateRtpParameters(rtpParameters);

					const { id } = await new Promise<{ id: string }>((resolve, reject) =>
					{
						this.safeEmit(
							'produce',
							{
								kind : track.kind as MediaKind,
								rtpParameters,
								appData
							},
							resolve,
							reject
						);
					});

					const producer = new Producer<ProducerAppData>(
						{
							id,
							localId,
							rtpSender,
							track,
							rtpParameters,
							stopTracks,
							disableTrackOnPause,
							zeroRtpOnPause,
							appData
						});

					this._producers.set(producer.id, producer);
					this.handleProducer(producer);

					// Emit observer event.
					this._observer.safeEmit('newproducer', producer);

					return producer;
				}
				catch (error)
				{
					this._handler.stopSending(localId)
						.catch(() => {});

					throw error;
				}
			},
			'transport.produce()')
			// This catch is needed to stop the given track if the command above
			// failed due to closed Transport.
			.catch((error: Error) =>
			{
				if (stopTracks)
				{
					try { track.stop(); }
					catch (error2) {}
				}

				throw error;
			});
	}

	/**
	 * Create a Consumer to consume a remote Producer.
	 */
	async consume<ConsumerAppData extends AppData = AppData>(
		{
			id,
			producerId,
			kind,
			rtpParameters,
			streamId,
			appData = {} as ConsumerAppData
		}: ConsumerOptions<ConsumerAppData>
	): Promise<Consumer<ConsumerAppData>>
	{
		logger.debug('consume()');

		rtpParameters = utils.clone(rtpParameters, undefined);

		if (this._closed)
		{
			throw new InvalidStateError('closed');
		}
		else if (this._direction !== 'recv')
		{
			throw new UnsupportedError('not a receiving Transport');
		}
		else if (typeof id !== 'string')
		{
			throw new TypeError('missing id');
		}
		else if (typeof producerId !== 'string')
		{
			throw new TypeError('missing producerId');
		}
		else if (kind !== 'audio' && kind !== 'video')
		{
			throw new TypeError(`invalid kind '${kind}'`);
		}
		else if (this.listenerCount('connect') === 0 && this._connectionState === 'new')
		{
			throw new TypeError('no "connect" listener set into this transport');
		}
		else if (appData && typeof appData !== 'object')
		{
			throw new TypeError('if given, appData must be an object');
		}

		// Ensure the device can consume it.
		const canConsume = ortc.canReceive(
			rtpParameters, this._extendedRtpCapabilities);

		if (!canConsume)
		{
			throw new UnsupportedError('cannot consume this Producer');
		}

		const consumerCreationTask = new ConsumerCreationTask(
			{
				id,
				producerId,
				kind,
				rtpParameters,
				streamId,
				appData
			}
		);

		// Store the Consumer creation task.
		this._pendingConsumerTasks.push(consumerCreationTask);

		// There is no Consumer creation in progress, create it now.
		queueMicrotask(() => 
		{
			if (this._closed)
			{
				return;
			}

			if (this._consumerCreationInProgress === false)
			{
				this.createPendingConsumers<ConsumerAppData>();
			}
		});

		return consumerCreationTask.promise as Promise<Consumer<ConsumerAppData>>;
	}

	/**
	 * Create a DataProducer
	 */
	async produceData<DataProducerAppData extends AppData = AppData>(
		{
			ordered = true,
			maxPacketLifeTime,
			maxRetransmits,
			label = '',
			protocol = '',
			appData = {} as DataProducerAppData
		}: DataProducerOptions<DataProducerAppData> = {}
	): Promise<DataProducer<DataProducerAppData>>
	{
		logger.debug('produceData()');

		if (this._closed)
		{
			throw new InvalidStateError('closed');
		}
		else if (this._direction !== 'send')
		{
			throw new UnsupportedError('not a sending Transport');
		}
		else if (!this._maxSctpMessageSize)
		{
			throw new UnsupportedError('SCTP not enabled by remote Transport');
		}
		else if (this.listenerCount('connect') === 0 && this._connectionState === 'new')
		{
			throw new TypeError('no "connect" listener set into this transport');
		}
		else if (this.listenerCount('producedata') === 0)
		{
			throw new TypeError('no "producedata" listener set into this transport');
		}
		else if (appData && typeof appData !== 'object')
		{
			throw new TypeError('if given, appData must be an object');
		}

		if (maxPacketLifeTime || maxRetransmits)
		{
			ordered = false;
		}

		// Enqueue command.
		return this._awaitQueue.push(
			async () =>
			{
				const {
					dataChannel,
					sctpStreamParameters
				} = await this._handler.sendDataChannel(
					{
						ordered,
						maxPacketLifeTime,
						maxRetransmits,
						label,
						protocol
					});

				// This will fill sctpStreamParameters's missing fields with default values.
				ortc.validateSctpStreamParameters(sctpStreamParameters);

				const { id } = await new Promise<{ id: string }>((resolve, reject) =>
				{
					this.safeEmit(
						'producedata',
						{
							sctpStreamParameters,
							label,
							protocol,
							appData
						},
						resolve,
						reject
					);
				});

				const dataProducer = new DataProducer<DataProducerAppData>(
					{
						id,
						dataChannel,
						sctpStreamParameters,
						appData
					});

				this._dataProducers.set(dataProducer.id, dataProducer);
				this.handleDataProducer(dataProducer);

				// Emit observer event.
				this._observer.safeEmit('newdataproducer', dataProducer);

				return dataProducer;
			},
			'transport.produceData()');
	}

	/**
	 * Create a DataConsumer
	 */
	async consumeData<ConsumerAppData extends AppData = AppData>(
		{
			id,
			dataProducerId,
			sctpStreamParameters,
			label = '',
			protocol = '',
			appData = {} as ConsumerAppData
		}: DataConsumerOptions<ConsumerAppData>
	): Promise<DataConsumer<ConsumerAppData>>
	{
		logger.debug('consumeData()');

		sctpStreamParameters = utils.clone(sctpStreamParameters, undefined);

		if (this._closed)
		{
			throw new InvalidStateError('closed');
		}
		else if (this._direction !== 'recv')
		{
			throw new UnsupportedError('not a receiving Transport');
		}
		else if (!this._maxSctpMessageSize)
		{
			throw new UnsupportedError('SCTP not enabled by remote Transport');
		}
		else if (typeof id !== 'string')
		{
			throw new TypeError('missing id');
		}
		else if (typeof dataProducerId !== 'string')
		{
			throw new TypeError('missing dataProducerId');
		}
		else if (this.listenerCount('connect') === 0 && this._connectionState === 'new')
		{
			throw new TypeError('no "connect" listener set into this transport');
		}
		else if (appData && typeof appData !== 'object')
		{
			throw new TypeError('if given, appData must be an object');
		}

		// This may throw.
		ortc.validateSctpStreamParameters(sctpStreamParameters);

		// Enqueue command.
		return this._awaitQueue.push(
			async () =>
			{
				const {
					dataChannel
				} = await this._handler.receiveDataChannel(
					{
						sctpStreamParameters,
						label,
						protocol
					});

				const dataConsumer = new DataConsumer<ConsumerAppData>(
					{
						id,
						dataProducerId,
						dataChannel,
						sctpStreamParameters,
						appData
					});

				this._dataConsumers.set(dataConsumer.id, dataConsumer);
				this.handleDataConsumer(dataConsumer);

				// Emit observer event.
				this._observer.safeEmit('newdataconsumer', dataConsumer);

				return dataConsumer;
			},
			'transport.consumeData()');
	}

	// This method is guaranteed to never throw.
	private async createPendingConsumers<ConsumerAppData extends AppData>(): Promise<void>
	{
		this._consumerCreationInProgress = true;

		this._awaitQueue.push(
			async () =>
			{
				if (this._pendingConsumerTasks.length === 0)
				{
					logger.debug('createPendingConsumers() | there is no Consumer to be created');

					return;
				}

				const pendingConsumerTasks = [ ...this._pendingConsumerTasks ];

				// Clear pending Consumer tasks.
				this._pendingConsumerTasks = [];

				// Video Consumer in order to create the probator.
				let videoConsumerForProbator: Consumer | undefined = undefined;

				// Fill options list.
				const optionsList: HandlerReceiveOptions[] = [];

				for (const task of pendingConsumerTasks)
				{
					const { id, kind, rtpParameters, streamId } = task.consumerOptions;

					optionsList.push(
						{
							trackId : id!,
							kind    : kind as MediaKind,
							rtpParameters,
							streamId
						});
				}

				try
				{
					const results = await this._handler.receive(optionsList);

					for (let idx = 0; idx < results.length; ++idx)
					{
						const task = pendingConsumerTasks[idx];
						const result = results[idx];
						const { id, producerId, kind, rtpParameters, appData } = task.consumerOptions;
						const { localId, rtpReceiver, track } = result;
						const consumer = new Consumer<ConsumerAppData>(
							{
								id         : id!,
								localId,
								producerId : producerId!,
								rtpReceiver,
								track,
								rtpParameters,
								appData    : appData as ConsumerAppData
							});

						this._consumers.set(consumer.id, consumer);
						this.handleConsumer(consumer);

						// If this is the first video Consumer and the Consumer for RTP probation
						// has not yet been created, it's time to create it.
						if (
							!this._probatorConsumerCreated &&
							!videoConsumerForProbator && kind === 'video'
						)
						{
							videoConsumerForProbator = consumer;
						}

						// Emit observer event.
						this._observer.safeEmit('newconsumer', consumer);

						task.resolve!(consumer);
					}
				}
				catch (error)
				{
					for (const task of pendingConsumerTasks)
					{
						task.reject!(error as Error);
					}
				}

				// If RTP probation must be handled, do it now.
				if (videoConsumerForProbator)
				{
					try
					{
						const probatorRtpParameters =
							ortc.generateProbatorRtpParameters(videoConsumerForProbator!.rtpParameters);

						await this._handler.receive(
							[ {
								trackId       : 'probator',
								kind          : 'video',
								rtpParameters : probatorRtpParameters
							} ]);

						logger.debug('createPendingConsumers() | Consumer for RTP probation created');

						this._probatorConsumerCreated = true;
					}
					catch (error)
					{
						logger.error(
							'createPendingConsumers() | failed to create Consumer for RTP probation:%o',
							error);
					}
				}
			},
			'transport.createPendingConsumers()')
			.then(() =>
			{
				this._consumerCreationInProgress = false;

				// There are pending Consumer tasks, enqueue their creation.
				if (this._pendingConsumerTasks.length > 0)
				{
					this.createPendingConsumers<ConsumerAppData>();
				}
			})
			// NOTE: We only get here when the await queue is closed.
			.catch(() => {});
	}

	private pausePendingConsumers()
	{
		this._consumerPauseInProgress = true;

		this._awaitQueue.push(
			async () =>
			{
				if (this._pendingPauseConsumers.size === 0)
				{
					logger.debug('pausePendingConsumers() | there is no Consumer to be paused');

					return;
				}

				const pendingPauseConsumers = Array.from(this._pendingPauseConsumers.values());

				// Clear pending pause Consumer map.
				this._pendingPauseConsumers.clear();

				try
				{
					const localIds = pendingPauseConsumers
						.map((consumer) => consumer.localId);

					await this._handler.pauseReceiving(localIds);
				}
				catch (error)
				{
					logger.error('pausePendingConsumers() | failed to pause Consumers:', error);
				}
			},
			'transport.pausePendingConsumers')
			.then(() =>
			{
				this._consumerPauseInProgress = false;

				// There are pending Consumers to be paused, do it.
				if (this._pendingPauseConsumers.size > 0)
				{
					this.pausePendingConsumers();
				}
			})
			// NOTE: We only get here when the await queue is closed.
			.catch(() => { });
	}

	private resumePendingConsumers()
	{
		this._consumerResumeInProgress = true;

		this._awaitQueue.push(
			async () =>
			{
				if (this._pendingResumeConsumers.size === 0)
				{
					logger.debug('resumePendingConsumers() | there is no Consumer to be resumed');
					
					return;
				}

				const pendingResumeConsumers = Array.from(this._pendingResumeConsumers.values());

				// Clear pending resume Consumer map.
				this._pendingResumeConsumers.clear();

				try
				{
					const localIds = pendingResumeConsumers
						.map((consumer) => consumer.localId);

					await this._handler.resumeReceiving(localIds);
				}
				catch (error)
				{
					logger.error('resumePendingConsumers() | failed to resume Consumers:', error);
				}
			},
			'transport.resumePendingConsumers')
			.then(() =>
			{
				this._consumerResumeInProgress = false;

				// There are pending Consumer to be resumed, do it.
				if (this._pendingResumeConsumers.size > 0)
				{
					this.resumePendingConsumers();
				}
			})
			// NOTE: We only get here when the await queue is closed.
			.catch(() => { });
	}

	private closePendingConsumers()
	{
		this._consumerCloseInProgress = true;

		this._awaitQueue.push(
			async () =>
			{
				if (this._pendingCloseConsumers.size === 0)
				{
					logger.debug('closePendingConsumers() | there is no Consumer to be closed');
					
					return;
				}

				const pendingCloseConsumers = Array.from(this._pendingCloseConsumers.values());

				// Clear pending close Consumer map.
				this._pendingCloseConsumers.clear();

				try
				{
					await this._handler.stopReceiving(
						pendingCloseConsumers.map((consumer) => consumer.localId)
					);
				}
				catch (error)
				{
					logger.error('closePendingConsumers() | failed to close Consumers:', error);
				}
			},
			'transport.closePendingConsumers')
			.then(() =>
			{
				this._consumerCloseInProgress = false;

				// There are pending Consumer to be resumed, do it.
				if (this._pendingCloseConsumers.size > 0)
				{
					this.closePendingConsumers();
				}
			})
			// NOTE: We only get here when the await queue is closed.
			.catch(() => { });
	}

	private handleHandler(): void
	{
		const handler = this._handler;

		handler.on('@connect', (
			{ dtlsParameters }: { dtlsParameters: DtlsParameters },
			callback: () => void,
			errback: (error: Error) => void
		) =>
		{
			if (this._closed)
			{
				errback(new InvalidStateError('closed'));

				return;
			}

			this.safeEmit('connect', { dtlsParameters }, callback, errback);
		});

		handler.on('@icegatheringstatechange', (iceGatheringState: IceGatheringState) =>
		{
			if (iceGatheringState === this._iceGatheringState)
			{
				return;
			}

			logger.debug('ICE gathering state changed to %s', iceGatheringState);

			this._iceGatheringState = iceGatheringState;

			if (!this._closed)
			{
				this.safeEmit('icegatheringstatechange', iceGatheringState);
			}
		});

		handler.on('@connectionstatechange', (connectionState: ConnectionState) =>
		{
			if (connectionState === this._connectionState)
			{
				return;
			}

			logger.debug('connection state changed to %s', connectionState);

			this._connectionState = connectionState;

			if (!this._closed)
			{
				this.safeEmit('connectionstatechange', connectionState);
			}
		});
	}

	private handleProducer(producer: Producer): void
	{
		producer.on('@close', () =>
		{
			this._producers.delete(producer.id);

			if (this._closed)
			{
				return;
			}

			this._awaitQueue.push(
				async () => await this._handler.stopSending(producer.localId),
				'producer @close event')
				.catch((error: Error) => logger.warn('producer.close() failed:%o', error));
		});

		producer.on('@pause', (callback, errback) =>
		{
			this._awaitQueue.push(
				async () => await this._handler.pauseSending(producer.localId),
				'producer @pause event')
				.then(callback)
				.catch(errback);
		});

		producer.on('@resume', (callback, errback) =>
		{
			this._awaitQueue.push(
				async () => await this._handler.resumeSending(producer.localId),
				'producer @resume event')
				.then(callback)
				.catch(errback);
		});

		producer.on('@replacetrack', (track, callback, errback) =>
		{
			this._awaitQueue.push(
				async () => await this._handler.replaceTrack(producer.localId, track),
				'producer @replacetrack event')
				.then(callback)
				.catch(errback);
		});

		producer.on('@setmaxspatiallayer', (spatialLayer, callback, errback) =>
		{
			this._awaitQueue.push(
				async () => (
					await this._handler.setMaxSpatialLayer(producer.localId, spatialLayer)
				), 'producer @setmaxspatiallayer event')
				.then(callback)
				.catch(errback);
		});

		producer.on('@setrtpencodingparameters', (params, callback, errback) =>
		{
			this._awaitQueue.push(
				async () => (
					await this._handler.setRtpEncodingParameters(producer.localId, params)
				), 'producer @setrtpencodingparameters event')
				.then(callback)
				.catch(errback);
		});

		producer.on('@getstats', (callback, errback) =>
		{
			if (this._closed)
			{
				return errback!(new InvalidStateError('closed'));
			}

			this._handler.getSenderStats(producer.localId)
				.then(callback)
				.catch(errback);
		});
	}

	private handleConsumer(consumer: Consumer): void
	{
		consumer.on('@close', () =>
		{
			this._consumers.delete(consumer.id);
			this._pendingPauseConsumers.delete(consumer.id);
			this._pendingResumeConsumers.delete(consumer.id);

			if (this._closed)
			{
				return;
			}

			// Store the Consumer into the close list.
			this._pendingCloseConsumers.set(consumer.id, consumer);

			// There is no Consumer close in progress, do it now.
			if (this._consumerCloseInProgress === false)
			{
				this.closePendingConsumers();
			}
		});

		consumer.on('@pause', () =>
		{
			// If Consumer is pending to be resumed, remove from pending resume list.
			if (this._pendingResumeConsumers.has(consumer.id))
			{
				this._pendingResumeConsumers.delete(consumer.id);
			}

			// Store the Consumer into the pending list.
			this._pendingPauseConsumers.set(consumer.id, consumer);

			// There is no Consumer pause in progress, do it now.
			queueMicrotask(() => 
			{
				if (this._closed)
				{
					return;
				}

				if (this._consumerPauseInProgress === false)
				{
					this.pausePendingConsumers();
				}
			});
		});

		consumer.on('@resume', () =>
		{
			// If Consumer is pending to be paused, remove from pending pause list.
			if (this._pendingPauseConsumers.has(consumer.id))
			{
				this._pendingPauseConsumers.delete(consumer.id);
			}

			// Store the Consumer into the pending list.
			this._pendingResumeConsumers.set(consumer.id, consumer);

			// There is no Consumer resume in progress, do it now.
			queueMicrotask(() => 
			{
				if (this._closed)
				{
					return;
				}

				if (this._consumerResumeInProgress === false)
				{
					this.resumePendingConsumers();
				}
			});
		});

		consumer.on('@getstats', (callback, errback) =>
		{
			if (this._closed)
			{
				return errback!(new InvalidStateError('closed'));
			}

			this._handler.getReceiverStats(consumer.localId)
				.then(callback)
				.catch(errback);
		});
	}

	private handleDataProducer(dataProducer: DataProducer): void
	{
		dataProducer.on('@close', () =>
		{
			this._dataProducers.delete(dataProducer.id);
		});
	}

	private handleDataConsumer(dataConsumer: DataConsumer): void
	{
		dataConsumer.on('@close', () =>
		{
			this._dataConsumers.delete(dataConsumer.id);
		});
	}
}
