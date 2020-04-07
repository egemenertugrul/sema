import Module from "./maximilian.wasmmodule.js"; //NOTE:FB We need this import here for webpack to emit maximilian.wasmmodule.js
import CustomProcessor from "./maxi-processor";
import {
  loadSampleToArray
} from "./maximilian.util";
import {
  kuramotoNetClock
} from "../interfaces/clockInterface.js";
import {
  PubSub
} from "../messaging/pubSub.js";
import {
  PeerStreaming
} from "../interfaces/peerStreaming.js";

/**
 * The CustomAudioNode is a class that extends AudioWorkletNode
 * to hold an Custom Audio Worklet Processor and connect to Web Audio graph
 * @class CustomAudioNode
 * @extends AudioWorkletNode
 */
class MaxiNode extends AudioWorkletNode {
  constructor(audioContext, processorName) {
    // super(audioContext, processorName);
    let options = {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2]
    };
    super(audioContext, processorName, options);
  }
}

/**
 * The AudioEngine is a singleton class that encapsulates the AudioContext
 * and all WASM and Maximilian -powered Audio Worklet Processor
 * @class AudioEngine
 */
class AudioEngine {
  /**
   * @constructor
   */
  constructor() {
    if (AudioEngine.instance) {
      return AudioEngine.instance; // Singleton pattern
    }
    AudioEngine.instance = this;

    // AudioContext needs lazy loading to workaround the Chrome warning
    // Audio Engine first play() call, triggered by user, prevents the warning
    // by setting this.audioContext = new AudioContext();
    this.audioContext;
    this.audioWorkletProcessorName = "maxi-processor";
    this.audioWorkletUrl = "maxi-processor.js";
    this.audioWorkletNode;
    this.samplesLoaded = false;

    // Hash of on-demand analysers (e.g. spectrogram, oscilloscope)
    this.analysers = {};

    // Sema's Publish-Subscribe pattern object with "lowercase-lowecase" format convention for subscription topic
    this.messaging = new PubSub();
    this.messaging.subscribe("eval-dsp", e => this.evalDSP(e));
    this.messaging.subscribe("stop-audio", e => this.stop());
    this.messaging.subscribe("load-sample", (name, url) =>
      this.loadSample(name, url)
    );
    this.messaging.subscribe("model-output-data", e =>
      this.onMessagingEventHandler(e)
    );
    this.messaging.subscribe("clock-phase", e =>
      this.onMessagingEventHandler(e)
    );
    this.messaging.subscribe("model-send-buffer", e => {
      this.onMessagingEventHandler(e)
    });
    this.messaging.subscribe("add-analyser", e =>
      this.createAnalyser(e.type, e.id)
    );
    this.messaging.subscribe("remove-analyser", e => this.removeAnalyser(e.id));
    // this.messaging.subscribe("osc", e => console.log(`DEBUG:AudioEngine:OSC: ${e}`));

    this.kuraClock = new kuramotoNetClock();

    this.peerNet = new PeerStreaming();
    this.messaging.subscribe("peermsg", (e)=> {
      console.log('peer', e);
      e.ttype = 'NET';
      e.peermsg = 1;
      this.onMessagingEventHandler(e);
    });
  }

  /**
   * Handler of audio worklet processor events
   * @onProcessorMessageEventHandler
   */
  onProcessorMessageEventHandler(event) {
    if (event != undefined && event.data != undefined) {
      // console.log("DEBUG:AudioEngine:processorMessageHandler:");
      // console.log(event);
      if (event.data === "giveMeSomeSamples") {} else if (event.data.phase != undefined) {
        // console.log('DEBUG:AudioEngine:phase:');
        // console.log(event.data.phase);
        this.kuraClock.broadcastPhase(event.data.phase); // TODO Refactor p to phase
      } else if (event.data.rq != undefined && event.data.rq === "send") {
        switch (event.data.ttype) {
          case 'ML':
            // Stream generated by 'toJS' live code instruction — e.g. {10,0,{1}sin}toJS;
            // publishes to model/JS editor, which posts to ml.worker
            this.messaging.publish("model-input-data", {
              type: "model-input-data",
              value: event.data.value,
              ch: event.data.ch, //channel ID
            });
            break;
          case 'NET':
            this.peerNet.send(event.data.ch[0], event.data.value, event.data.ch[1]);
            break;
        }
      }
      // else if (event.data.rq != undefined && event.data.rq === "receive") {
      //   switch (event.data.ttype) {
      //     case 'ML':
      //       // Stream generated by 'fromJS' live code instruction – e.g. {{10,1}fromJS}saw
      //       // publishes to model/JS editor, which posts to ml.worker
      //       this.messaging.publish("model-output-data-request", {
      //         type: "model-output-data-request",
      //         value: event.data.value,
      //         channel: event.data.ch
      //       });
      //       break;
      //     case 'NET':
      //       break;
      //   }
      // }
    }
  }

  /**
   * Handler of the Pub/Sub message events
   * whose topics are subscribed to in the audio engine constructor
   * @onMessagingEventHandler
   */
  onMessagingEventHandler(event) {
    if (event != undefined) {
      // Receive notification from "model-output-data" topic
      // console.log("DEBUG:AudioEngine:onMessagingEventHandler:");
      // console.log(event);
      this.audioWorkletNode.port.postMessage(event);
    }
  }

  /**
   * Creates a WAAPI analyser node
   * @todo configuration object as argumen
   * @createAnalyser
   */
  createAnalyser(name) {
    if (this.audioContext !== undefined) {
      let analyser = this.audioContext.createAnalyser();
      analyser.fftSize = 2048;
      let dataArray = new Uint8Array(analyser.frequencyBinCount);
      analyser.getByteTimeDomainData(dataArray);
      this.analysers[name] = analyser;
      this.connectAnalyser(analyser); // @todo Move out
    }
  }

  /**
   * Creates a WAAPI analyser node
   * TODO configuration object as argument
   * @createAnalyser
   */
  removeAnalyser(name) {
    if (this.audioContext !== undefined) {
      let analyser = this.analysers[name];
      if (analyser !== undefined) {
        this.disconnectAnalyser(analyser); // @todo Move out
        delete this.analysers[name];
      }
    }
  }

  /**
   * Connects WAAPI analyser node to the main audio worklet for visualisation.
   * @disconnectAnalyser
   */
  disconnectAnalyser(analyser) {
    if (this.audioWorkletNode !== undefined) {
      this.audioWorkletNode.disconnect(analyser);
    }
  }

  /**
   * Connects WAAPI analyser node to the main audio worklet for visualisation.
   * @connectAnalyser
   */
  connectAnalyser(analyser) {
    if (this.audioWorkletNode !== undefined) {
      this.audioWorkletNode.connect(analyser);
    }
  }

  // NOTE:FB Test code should be segregated from production code into its own fixture.
  // Otherwise, it becomes bloated, difficult to read and reason about.
  // messageHandler(data) {
  // 	if (data == "dspStart") {
  // 		this.ts = window.performance.now();
  // 	}
  // 	if (data == "dspEnd") {
  // 		this.ts = window.performance.now() - this.ts;
  // 		this.dspTime = this.dspTime * 0.9 + this.ts * 0.1; //time for 128 sample buffer
  // 		this.onNewDSPLoadValue((this.dspTime / 2.90249433106576) * 100);
  // 	}
  // 	if (data == "evalEnd") {
  // 		let evalts = window.performance.now();
  // 		this.onEvalTimestamp(evalts);
  // 	} else if (data == "evalEnd") {
  // 		let evalts = window.performance.now();
  // 		this.onEvalTimestamp(evalts);
  // 	} else if (data == "giveMeSomeSamples") {
  // 		// this.msgHandler("giveMeSomeSamples");    	// NOTE:FB Untangling the previous msgHandler hack from the audio engine
  // 	} else {
  // 		this.msgHandler(data);
  // 	}
  // }

  /**
   * Initialises audio context and sets worklet processor code
   * @play
   */
  async init(numClockPeers) {
    if (this.audioContext === undefined) {
      this.audioContext = new AudioContext({
        // create audio context with latency optimally configured for playback
        latencyHint: "playback",
        sample: 44100
      });

      await this.loadWorkletProcessorCode();
      this.connectMediaStream();
      this.loadImportedSamples();

      // No need to inject the callback here, messaging is built in KuraClock
      // this.kuraClock = new kuramotoNetClock((phase, idx) => {
      //   // console.log( `DEBUG:AudioEngine:sendPeersMyClockPhase:phase:${phase}:id:${idx}`);
      //   // This requires an initialised audio worklet
      //   this.audioWorkletNode.port.postMessage({ phase: phase, i: idx });
      // });

      if (this.kuraClock.connected()) {
        this.kuraClock.queryPeers(async numClockPeers => {
          console.log(`DEBUG:AudioEngine:init:numClockPeers: ${numClockPeers}`);
        });
      }
    }
  }

  /**
   * Initialises audio context and sets worklet processor code
   * or re-starts audio playback by stopping and running the latest Audio Worklet Processor code
   * @play
   */
  play() {
    if (this.audioContext !== undefined) {
      if (this.audioContext.state !== "suspended") {
        this.stop();
        return false;
      } else {
        this.audioContext.resume();
        return true;
      }
    }
  }

  /**
   * Suspends AudioContext (Pause)
   * @stop
   */
  stop() {
    if (this.audioWorkletNode !== undefined) {
      this.audioContext.suspend();
    }
  }

  /**
   * Stops audio by disconnecting AudioNode with AudioWorkletProcessor code
   * from Web Audio graph TODO Investigate when it is best to just STOP the graph exectution
   * @stop
   */
  stopAndRelease() {
    if (this.audioWorkletNode !== undefined) {
      this.audioWorkletNode.disconnect(this.audioContext.destination);
      this.audioWorkletNode = undefined;
    }
  }

  more(gain) {
    if (this.audioWorkletNode !== undefined) {
      const gainParam = this.audioWorkletNode.parameters.get(gain);
      gainParam.value += 0.5;
      console.log(gain + ": " + gainParam.value); // DEBUG
      return true;
    } else return false;
  }

  less(gain) {
    if (this.audioWorkletNode !== undefined) {
      const gainParam = this.audioWorkletNode.parameters.get(gain);
      gainParam.value -= 0.5;
      console.log(gain + ": " + gainParam.value); // DEBUG
      return true;
    } else return false;
  }

  evalDSP(dspFunction) {
    // console.log("DEBUG:AudioEngine:evalDSP:");
    // console.log(dspFunction);
    if (this.audioWorkletNode !== undefined) {
      if (this.audioContext.state === "suspended") this.audioContext.resume();
      this.audioWorkletNode.port.postMessage({
        eval: 1,
        setup: dspFunction.setup,
        loop: dspFunction.loop
      });
      return true;
    } else return false;
  }

  sendClockPhase(phase, idx) {
    if (this.audioWorkletNode !== undefined) {
      this.audioWorkletNode.port.postMessage({
        phase: phase,
        i: idx
      });
    }
  }

  onAudioInputInit(stream) {
    // console.log("DEBUG:AudioEngine: Audio Input init");
    let mediaStreamSource = this.audioContext.createMediaStreamSource(stream);
    mediaStreamSource.connect(this.audioWorkletNode);
  }

  onAudioInputFail(error) {
    console.log(
      `DEBUG:AudioEngine:AudioInputFail: ${error.message} ${error.name}`
    );
  }

  /**
   * Sets up an AudioIn WAAPI sub-graph
   * @connectMediaStreamSourceInput
   */
  async connectMediaStream() {
    const constraints = (window.constraints = {
      audio: true,
      video: false
    });

    navigator.mediaDevices
      .getUserMedia(constraints)
      .then(s => this.onAudioInputInit(s))
      .catch(this.onAudioInputFail);
  }

  /**
   * Loads audioWorklet processor code into a worklet,
   * setups up all handlers (errors, async messaging, etc),
   * connects the worklet processor to the WAAPI graph
   *
   */
  async loadWorkletProcessorCode() {
    if (this.audioContext !== undefined) {
      try {
        await this.audioContext.audioWorklet.addModule(this.audioWorkletUrl);

        // Custom node constructor with required parameters
        this.audioWorkletNode = new MaxiNode(
          this.audioContext,
          this.audioWorkletProcessorName
        );

        // All possible error event handlers subscribed
        this.audioWorkletNode.onprocessorerror = event => {
          // Errors from the processor
          console.log(
            `DEBUG:AudioEngine:loadWorkletProcessorCode: MaxiProcessor Error detected`
          );
        };

        this.audioWorkletNode.port.onmessageerror = event => {
          //  error from the processor port
          console.log(
            `DEBUG:AudioEngine:loadWorkletProcessorCode: Error message from port: ` +
            event.data
          );
        };

        // State changes in the audio worklet processor
        this.audioWorkletNode.onprocessorstatechange = event => {
          console.log(
            `DEBUG:AudioEngine:loadWorkletProcessorCode: MaxiProcessor state change detected: ` +
            audioWorkletNode.processorState
          );
        };

        // Worklet Processor message handler
        this.audioWorkletNode.port.onmessage = event => {
          this.onProcessorMessageEventHandler(event);
        };

        // Connect the worklet node to the audio graph
        this.audioWorkletNode.connect(this.audioContext.destination);

        return true;
      } catch (err) {
        console.log(
          "DEBUG:AudioEngine:loadWorkletProcessorCode: AudioWorklet not supported in this browser: ",
          err.message
        );
        return false;
      }
    } else {
      return false;
    }
  }

  getSamplesNames() {
    const r = require.context("../../assets/samples", false, /\.wav$/);

    // return an array list of filenames (with extension)
    const importAll = r => r.keys().map(file => file.match(/[^\/]+$/)[0]);

    return importAll(r);
  }

  loadSample(objectName, url) {
    if (this.audioContext !== undefined) {
      loadSampleToArray(
        this.audioContext,
        objectName,
        url,
        this.audioWorkletNode
      );
    } else throw "Audio Context is not initialised!";
  }

  lazyLoadSample(sampleName, sample) {
    import( /* webpackMode: "lazy" */ `../../assets/samples/${sampleName}`)
      .then(sample => this.loadSample(sampleName, `samples/${sampleName}`))
      .catch(err => console.error(`DEBUG:AudioEngine:lazyLoadSample: ` + err));
  }

  loadImportedSamples() {
    let samplesNames = this.getSamplesNames();
    console.log("DEBUG:AudioEngine:getSamplesNames: " + samplesNames);
    samplesNames.forEach(sampleName => {
      this.lazyLoadSample(sampleName);
    });
  }
}

export {
  AudioEngine
};
