const tf = require('@tensorflow/tfjs');
const facemesh = require('./facemesh/facemesh.js');
const ssrnet = require('./ssrnet/ssrnet.js');
const emotion = require('./emotion/emotion.js');
const posenet = require('./posenet/posenet.js');
const handpose = require('./handpose/handpose.js');
const fxImage = require('./imagefx.js');
const profile = require('./profile.js');
const defaults = require('../config.js').default;
const app = require('../package.json');

// static config override for non-video detection
const override = {
  face: { detector: { skipFrames: 0 }, age: { skipFrames: 0 }, emotion: { skipFrames: 0 } },
  hand: { skipFrames: 0 },
};

// helper function: gets elapsed time on both browser and nodejs
const now = () => {
  if (typeof performance !== 'undefined') return performance.now();
  return parseInt(Number(process.hrtime.bigint()) / 1000 / 1000);
};

// helper function: perform deep merge of multiple objects so it allows full inheriance with overrides
function mergeDeep(...objects) {
  const isObject = (obj) => obj && typeof obj === 'object';
  return objects.reduce((prev, obj) => {
    Object.keys(obj || {}).forEach((key) => {
      const pVal = prev[key];
      const oVal = obj[key];
      if (Array.isArray(pVal) && Array.isArray(oVal)) {
        prev[key] = pVal.concat(...oVal);
      } else if (isObject(pVal) && isObject(oVal)) {
        prev[key] = mergeDeep(pVal, oVal);
      } else {
        prev[key] = oVal;
      }
    });
    return prev;
  }, {});
}

class Human {
  constructor() {
    this.tf = tf;
    this.version = app.version;
    this.defaults = defaults;
    this.config = defaults;
    this.fx = null;
    this.state = 'idle';
    this.numTensors = 0;
    this.analyzeMemoryLeaks = false;
    this.checkSanity = false;
    this.firstRun = true;
    // internal temp canvases
    this.inCanvas = null;
    this.outCanvas = null;
    // object that contains all initialized models
    this.models = {
      facemesh: null,
      posenet: null,
      handpose: null,
      iris: null,
      age: null,
      gender: null,
      emotion: null,
    };
    // export raw access to underlying models
    this.facemesh = facemesh;
    this.ssrnet = ssrnet;
    this.emotion = emotion;
    this.posenet = posenet;
    this.handpose = handpose;
  }

  // helper function: wrapper around console output
  log(...msg) {
    // eslint-disable-next-line no-console
    if (msg && this.config.console) console.log('Human:', ...msg);
  }

  profile() {
    if (this.config.profile) return profile.data;
    return {};
  }

  // helper function: measure tensor leak
  analyze(...msg) {
    if (!this.analyzeMemoryLeaks) return;
    const current = tf.engine().state.numTensors;
    const previous = this.numTensors;
    this.numTensors = current;
    const leaked = current - previous;
    if (leaked !== 0) this.log(...msg, leaked);
  }

  sanity(input) {
    if (!this.checkSanity) return null;
    if (!input) return 'input is not defined';
    if (tf.ENV.flags.IS_NODE && !(input instanceof tf.Tensor)) {
      return 'input must be a tensor';
    }
    try {
      tf.getBackend();
    } catch {
      return 'backend not loaded';
    }
    return null;
  }

  async load(userConfig) {
    if (userConfig) this.config = mergeDeep(defaults, userConfig);

    if (this.firstRun) {
      this.log(`version: ${this.version} TensorFlow/JS version: ${tf.version_core}`);
      this.log('configuration:', this.config);
      this.log('flags:', tf.ENV.flags);
      this.firstRun = false;
    }

    if (this.config.face.enabled && !this.models.facemesh) {
      this.log('load model: face');
      this.models.facemesh = await facemesh.load(this.config.face);
    }
    if (this.config.body.enabled && !this.models.posenet) {
      this.log('load model: body');
      this.models.posenet = await posenet.load(this.config.body);
    }
    if (this.config.hand.enabled && !this.models.handpose) {
      this.log('load model: hand');
      this.models.handpose = await handpose.load(this.config.hand);
    }
    if (this.config.face.enabled && this.config.face.age.enabled && !this.models.age) {
      this.log('load model: age');
      this.models.age = await ssrnet.loadAge(this.config);
    }
    if (this.config.face.enabled && this.config.face.gender.enabled && !this.models.gender) {
      this.log('load model: gender');
      this.models.gender = await ssrnet.loadGender(this.config);
    }
    if (this.config.face.enabled && this.config.face.emotion.enabled && !this.models.emotion) {
      this.log('load model: emotion');
      this.models.emotion = await emotion.load(this.config);
    }
  }

  async checkBackend() {
    if (tf.getBackend() !== this.config.backend) {
      this.state = 'backend';
      /* force backend reload
      if (this.config.backend in tf.engine().registry) {
        const backendFactory = tf.findBackendFactory(this.config.backend);
        tf.removeBackend(this.config.backend);
        tf.registerBackend(this.config.backend, backendFactory);
      } else {
        this.log('Backend not registred:', this.config.backend);
      }
      */
      this.log('Setting backend:', this.config.backend);
      await tf.setBackend(this.config.backend);
      tf.enableProdMode();
      /* debug mode is really too mcuh
      if (this.config.profile) tf.enableDebugMode();
      else tf.enableProdMode();
      */
      if (this.config.deallocate && this.config.backend === 'webgl') {
        this.log('Changing WebGL: WEBGL_DELETE_TEXTURE_THRESHOLD:', this.config.deallocate);
        tf.ENV.set('WEBGL_DELETE_TEXTURE_THRESHOLD', this.config.deallocate ? 0 : -1);
      }
      tf.ENV.set('WEBGL_CPU_FORWARD', true);
      await tf.ready();
    }
  }

  tfImage(input) {
    let tensor;
    if (input instanceof tf.Tensor) {
      tensor = tf.clone(input);
    } else {
      const originalWidth = input.naturalWidth || input.videoWidth || input.width || (input.shape && (input.shape[1] > 0));
      const originalHeight = input.naturalHeight || input.videoHeight || input.height || (input.shape && (input.shape[2] > 0));
      let targetWidth = originalWidth;
      let targetHeight = originalHeight;
      if (this.config.filter.width > 0) targetWidth = this.config.filter.width;
      else if (this.config.filter.height > 0) targetWidth = originalWidth * (this.config.filter.height / originalHeight);
      if (this.config.filter.height > 0) targetHeight = this.config.filter.height;
      else if (this.config.filter.width > 0) targetHeight = originalHeight * (this.config.filter.width / originalWidth);
      if (!this.inCanvas || (this.inCanvas.width !== targetWidth) || (this.inCanvas.height !== targetHeight)) {
        this.inCanvas = (typeof OffscreenCanvas !== 'undefined') ? new OffscreenCanvas(targetWidth, targetHeight) : document.createElement('canvas');
        if (this.inCanvas.width !== targetWidth) this.inCanvas.width = targetWidth;
        if (this.inCanvas.height !== targetHeight) this.inCanvas.height = targetHeight;
      }
      const ctx = this.inCanvas.getContext('2d');
      if (input instanceof ImageData) ctx.putImageData(input, 0, 0);
      else ctx.drawImage(input, 0, 0, originalWidth, originalHeight, 0, 0, this.inCanvas.width, this.inCanvas.height);
      if (this.config.filter.enabled) {
        if (!this.fx || !this.outCanvas || (this.inCanvas.width !== this.outCanvas.width) || (this.inCanvas.height !== this.outCanvas.height)) {
          this.outCanvas = (typeof OffscreenCanvas !== 'undefined') ? new OffscreenCanvas(this.inCanvas.width, this.inCanvas.height) : document.createElement('canvas');
          if (this.outCanvas.width !== this.inCanvas.width) this.outCanvas.width = this.inCanvas.width;
          if (this.outCanvas.height !== this.inCanvas.height) this.outCanvas.height = this.inCanvas.height;
          this.fx = (tf.ENV.flags.IS_BROWSER && (typeof document !== 'undefined')) ? new fxImage.Canvas({ canvas: this.outCanvas }) : null;
        }
        this.fx.reset();
        this.fx.addFilter('brightness', this.config.filter.brightness); // must have at least one filter enabled
        if (this.config.filter.contrast !== 0) this.fx.addFilter('contrast', this.config.filter.contrast);
        if (this.config.filter.sharpness !== 0) this.fx.addFilter('sharpen', this.config.filter.sharpness);
        if (this.config.filter.blur !== 0) this.fx.addFilter('blur', this.config.filter.blur);
        if (this.config.filter.saturation !== 0) this.fx.addFilter('saturation', this.config.filter.saturation);
        if (this.config.filter.hue !== 0) this.fx.addFilter('hue', this.config.filter.hue);
        if (this.config.filter.negative) this.fx.addFilter('negative');
        if (this.config.filter.sepia) this.fx.addFilter('sepia');
        if (this.config.filter.vintage) this.fx.addFilter('brownie');
        if (this.config.filter.sepia) this.fx.addFilter('sepia');
        if (this.config.filter.kodachrome) this.fx.addFilter('kodachrome');
        if (this.config.filter.technicolor) this.fx.addFilter('technicolor');
        if (this.config.filter.polaroid) this.fx.addFilter('polaroid');
        if (this.config.filter.pixelate !== 0) this.fx.addFilter('pixelate', this.config.filter.pixelate);
        this.fx.apply(this.inCanvas);
      }
      if (!this.outCanvas) this.outCanvas = this.inCanvas;
      let pixels;
      if ((this.config.backend === 'webgl') || (this.outCanvas instanceof ImageData)) {
        // tf kernel-optimized method to get imagedata, also if input is imagedata, just use it
        pixels = tf.browser.fromPixels(this.outCanvas);
      } else {
        // cpu and wasm kernel does not implement efficient fromPixels method nor we can use canvas as-is, so we do a silly one more canvas
        const tempCanvas = (typeof OffscreenCanvas !== 'undefined') ? new OffscreenCanvas(targetWidth, targetHeight) : document.createElement('canvas');
        tempCanvas.width = targetWidth;
        tempCanvas.height = targetHeight;
        const tempCtx = tempCanvas.getContext('2d');
        tempCtx.drawImage(this.outCanvas, 0, 0);
        const data = tempCtx.getImageData(0, 0, targetWidth, targetHeight);
        pixels = tf.browser.fromPixels(data);
      }
      const casted = pixels.toFloat();
      tensor = casted.expandDims(0);
      pixels.dispose();
      casted.dispose();
    }
    return { tensor, canvas: this.config.filter.return ? this.outCanvas : null };
  }

  async detect(input, userConfig = {}) {
    this.state = 'config';
    const perf = {};
    let timeStamp;

    this.config = mergeDeep(defaults, userConfig);
    if (!this.config.videoOptimized) this.config = mergeDeep(this.config, override);

    // sanity checks
    this.state = 'check';
    const error = this.sanity(input);
    if (error) {
      this.log(error, input);
      return { error };
    }

    // eslint-disable-next-line no-async-promise-executor
    return new Promise(async (resolve) => {
      let poseRes;
      let handRes;
      let ssrRes;
      let emotionRes;

      const timeStart = now();

      // configure backend
      timeStamp = now();
      await this.checkBackend();
      perf.backend = Math.trunc(now() - timeStamp);

      // load models if enabled
      timeStamp = now();
      this.state = 'load';
      await this.load();
      perf.load = Math.trunc(now() - timeStamp);

      if (this.config.scoped) tf.engine().startScope();

      this.analyze('Start Detect:');

      timeStamp = now();
      const image = this.tfImage(input);
      perf.image = Math.trunc(now() - timeStamp);
      const imageTensor = image.tensor;

      // run facemesh, includes blazeface and iris
      const faceRes = [];
      if (this.config.face.enabled) {
        this.state = 'run:face';
        timeStamp = now();
        this.analyze('Start FaceMesh:');
        const faces = await this.models.facemesh.estimateFaces(imageTensor, this.config.face);
        perf.face = Math.trunc(now() - timeStamp);
        for (const face of faces) {
          // is something went wrong, skip the face
          if (!face.image || face.image.isDisposedInternal) {
            this.log('Face object is disposed:', face.image);
            continue;
          }
          // run ssr-net age & gender, inherits face from blazeface
          this.state = 'run:agegender';
          timeStamp = now();
          ssrRes = (this.config.face.age.enabled || this.config.face.gender.enabled) ? await ssrnet.predict(face.image, this.config) : {};
          perf.agegender = Math.trunc(now() - timeStamp);
          // run emotion, inherits face from blazeface
          this.state = 'run:emotion';
          timeStamp = now();
          emotionRes = this.config.face.emotion.enabled ? await emotion.predict(face.image, this.config) : {};
          perf.emotion = Math.trunc(now() - timeStamp);

          // dont need face anymore
          face.image.dispose();
          // calculate iris distance
          // iris: array[ bottom, left, top, right, center ]
          const iris = (face.annotations.leftEyeIris && face.annotations.rightEyeIris)
            ? Math.max(face.annotations.leftEyeIris[3][0] - face.annotations.leftEyeIris[1][0], face.annotations.rightEyeIris[3][0] - face.annotations.rightEyeIris[1][0])
            : 0;
          faceRes.push({
            confidence: face.confidence,
            box: face.box,
            mesh: face.mesh,
            annotations: face.annotations,
            age: ssrRes.age,
            gender: ssrRes.gender,
            agConfidence: ssrRes.confidence,
            emotion: emotionRes,
            iris: (iris !== 0) ? Math.trunc(100 * 11.7 /* human iris size in mm */ / iris) / 100 : 0,
          });
          this.analyze('End FaceMesh:');
        }
      }

      // run posenet
      if (this.config.async) {
        poseRes = this.config.body.enabled ? this.models.posenet.estimatePoses(imageTensor, this.config.body) : [];
      } else {
        this.state = 'run:body';
        timeStamp = now();
        this.analyze('Start PoseNet');
        poseRes = this.config.body.enabled ? await this.models.posenet.estimatePoses(imageTensor, this.config.body) : [];
        this.analyze('End PoseNet:');
        perf.body = Math.trunc(now() - timeStamp);
      }

      // run handpose
      if (this.config.async) {
        handRes = this.config.hand.enabled ? this.models.handpose.estimateHands(imageTensor, this.config.hand) : [];
      } else {
        this.state = 'run:hand';
        timeStamp = now();
        this.analyze('Start HandPose:');
        handRes = this.config.hand.enabled ? await this.models.handpose.estimateHands(imageTensor, this.config.hand) : [];
        this.analyze('End HandPose:');
        perf.hand = Math.trunc(now() - timeStamp);
      }

      if (this.config.async) [poseRes, handRes] = await Promise.all([poseRes, handRes]);

      imageTensor.dispose();
      this.state = 'idle';

      if (this.config.scoped) tf.engine().endScope();
      this.analyze('End Scope:');

      perf.total = Math.trunc(now() - timeStart);
      resolve({ face: faceRes, body: poseRes, hand: handRes, performance: perf, canvas: image.canvas });
    });
  }
}

export { Human as default };
