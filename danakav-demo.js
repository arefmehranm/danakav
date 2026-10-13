/*
 * danakav.ir — backend-free demo runtime.
 *
 * This file is injected at deploy time into the production build of the Vue UI
 * (see build-demo-zip.mjs). It is never imported by the application sources, so
 * the repository code stays untouched. It turns the built SPA into a fully
 * self-contained demo that needs no ThingsBoard backend:
 *
 *   1. forces the hash router to start on the public landing page (/landing),
 *   2. swaps the axios adapter for a deterministic in-memory mock of the
 *      ThingsBoard REST API (login, user info, devices, telemetry, alarms …),
 *   3. fakes the /api/ws WebSocket the app uses for live counts and maps,
 *   4. proxies the «تحلیل هوش مصنوعی» calls (/ai/*) to TSFM.ai + OpenRouter,
 *   5. accepts a single hard-coded customer credential pair on the login form,
 *   6. shows a small floating hint with those credentials on the login page.
 *
 * Everything is deterministic: telemetry is generated from a seeded PRNG, so
 * charts look identical on every load and in screenshots.
 */
(function () {
  'use strict';

  // -------------------------------------------------------------------------
  // Deployment configuration (safe to edit after unzipping).
  // -------------------------------------------------------------------------
  var DEMO = (window.DANAKAV_DEMO_CONFIG = Object.assign(
    {
      username: 'demo',
      password: 'danakav',
      customerTitle: 'مشتری نمونه',
      aiProxy: true,
      // Optional: point the AI feature at your own proxy instead of the
      // bundled upstreams. Leave empty to use the bundled credentials.
      llmEndpoint: '',
      llmKey: '',
      llmModel: '',
      tsfmEndpoint: '',
      tsfmKey: '',
      tsfmModel: '',
    },
    window.DANAKAV_DEMO_CONFIG || {},
  ));

  var FALLBACK_LLM = {
    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    key: '',
    // The build's default model is frequently overloaded upstream; these two
    // free models answered reliably and the second is the retry.
    model: 'nvidia/nemotron-3-super-120b-a12b:free',
    modelAlt: 'nvidia/nemotron-3.5-lightning:free',
  };
  var FALLBACK_TSFM = {
    endpoint: 'https://api.tsfm.ai/v1/forecast',
    key: 'sk-627ab902c9286d873643d2045a1d76dd52626708',
    model: 'amazon/chronos-bolt-small',
  };

  // -------------------------------------------------------------------------
  // Deterministic PRNG + series generator (mirrors render/series.ts).
  // -------------------------------------------------------------------------
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = Math.trunc(a);
      a = Math.trunc(a + 0x6d2b79f5);
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hashSeed(text) {
    var h = 2166136261;
    for (var i = 0; i < text.length; i += 1) {
      h ^= text.codePointAt(i) || 0;
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }
  function genSeries(seed, base, count, amp, jitter, drift) {
    amp = amp === undefined ? base * 0.06 : amp;
    jitter = jitter === undefined ? base * 0.015 : jitter;
    drift = drift === undefined ? 0 : drift;
    var rand = mulberry32(seed);
    var out = [];
    for (var i = 0; i < count; i += 1) {
      var phase = (i / count) * Math.PI * 2;
      var value =
        base +
        Math.sin(phase) * amp +
        Math.cos(phase * 1.7) * amp * 0.35 +
        (i / count) * drift +
        (rand() - 0.5) * 2 * jitter;
      out.push(Number(value.toFixed(2)));
    }
    return out;
  }
  function uuidFrom(text) {
    var h1 = hashSeed(text);
    var h2 = hashSeed(text + '#2');
    var h3 = hashSeed(text + '#3');
    var h4 = hashSeed(text + '#4');
    function hex(n) {
      return (n >>> 0).toString(16).padStart(8, '0');
    }
    return (
      hex(h1) + '-' + hex(h2).slice(0, 4) + '-4' + hex(h3).slice(0, 3) + '-' +
      'a' + hex(h4).slice(0, 3) + '-' + hex(h1 ^ h2) + hex(h3).slice(0, 4)
    );
  }

  // -------------------------------------------------------------------------
  // Fake entities: devices with realistic live telemetry.
  // -------------------------------------------------------------------------
  var DEVICE_DEFS = [
    { name: 'NexIoT-Modbus-Serial-01', profile: 'Modbus RTU', keys: { temperature: 68, humidity: 44, power: 320, pressure: 6.2, mode: 1 } },
    { name: 'NexIoT-OPCUA-01', profile: 'OPC-UA', keys: { temperature: 71, humidity: 40, power: 355, frequency: 50, relay: 1 } },
    { name: 'NexIoT-S7-01', profile: 'Siemens S7', keys: { temperature: 64, humidity: 47, power: 288, speed: 1450, relay: 1 } },
    { name: 'OPCUA-Machine-01', profile: 'OPC-UA', keys: { temperature: 73, humidity: 38, power: 402, frequency: 49.8, relay: 1 } },
    { name: 'MQTT-Sensor-01', profile: 'MQTT', keys: { temperature: 59, humidity: 55, power: 214, frequency: 50.1, relay: 0 } },
    { name: 'S7-PLC-01', profile: 'Siemens S7', keys: { temperature: 66, humidity: 42, power: 265, speed: 1480, relay: 1 } },
    { name: 'BACnet-HVAC-01', profile: 'BACnet', keys: { temperature: 22, humidity: 51, power: 128, co2: 640, fan: 1 } },
    { name: 'SNMP-Switch-01', profile: 'SNMP', keys: { temperature: 41, power: 92, rssi: -58, uptime: 214 } },
    { name: 'HTTP-Machine-01', profile: 'HTTP', keys: { temperature: 62, humidity: 45, power: 301, flow: 118, efficiency: 91 } },
    { name: 'Socket-Machine-01', profile: 'Socket', keys: { temperature: 69, humidity: 43, power: 334, pressure: 5.8, relay: 1 } },
  ];

  var TENANT_ID = uuidFrom('danakav-tenant');
  var CUSTOMER_ID = uuidFrom('danakav-customer');
  var USER_ID = uuidFrom('danakav-user');

  function buildTelemetry(name, keys) {
    var now = Date.now();
    var series = {};
    var history = {};
    Object.keys(keys).forEach(function (key) {
      var base = keys[key];
      var amp = Math.abs(base) > 20 ? base * 0.08 : 1;
      var seed = hashSeed(name + ':' + key);
      series[key] = genSeries(seed, base, 24, amp, amp * 0.25).map(
        function (value, i) {
          return { ts: now - (23 - i) * 3600000, value: value };
        },
      );
      history[key] = genSeries(seed + 7, base, 168, amp, amp * 0.3, amp).map(
        function (value, i) {
          return { ts: now - (167 - i) * 3600000, value: value };
        },
      );
    });
    return { series: series, history: history };
  }

  var DEVICES = DEVICE_DEFS.map(function (def, index) {
    return {
      id: uuidFrom('device:' + def.name),
      createdTime: 1735000000000 + index * 86400000,
      name: def.name,
      profile: def.profile,
      keys: def.keys,
      active: index % 7 !== 0,
      telemetry: buildTelemetry(def.name, def.keys),
    };
  });

  var PROFILES = {};
  DEVICES.forEach(function (device) {
    if (!PROFILES[device.profile]) {
      PROFILES[device.profile] = {
        id: uuidFrom('profile:' + device.profile),
        name: device.profile,
        type: 'DEFAULT',
      };
    }
  });

  function entityId(type, id) {
    return { entityType: type, id: id };
  }
  function deviceInfo(device) {
    var profile = PROFILES[device.profile];
    return {
      id: entityId('DEVICE', device.id),
      createdTime: device.createdTime,
      name: device.name,
      label: device.name,
      type: device.profile,
      deviceProfileId: entityId('DEVICE_PROFILE', profile.id),
      deviceProfileName: device.profile,
      customerId: entityId('CUSTOMER', CUSTOMER_ID),
      customerTitle: DEMO.customerTitle,
      tenantId: entityId('TENANT', TENANT_ID),
      active: device.active,
    };
  }
  function deviceEntity(device) {
    var info = deviceInfo(device);
    delete info.active;
    delete info.deviceProfileName;
    delete info.customerTitle;
    return info;
  }
  function profileInfo(profile) {
    return {
      id: entityId('DEVICE_PROFILE', profile.id),
      createdTime: 1734000000000,
      name: profile.name,
      type: profile.type,
      transportType: 'DEFAULT',
    };
  }

  var CUSTOMER = {
    id: entityId('CUSTOMER', CUSTOMER_ID),
    createdTime: 1734000000000,
    title: DEMO.customerTitle,
    name: DEMO.customerTitle,
    email: 'customer@danakav.ir',
    country: 'Iran',
    city: 'Tehran',
    address: '',
    phone: '',
    additionalInfo: null,
  };

  var CUSTOMER_USER = {
    id: entityId('USER', USER_ID),
    createdTime: 1734000000000,
    authority: 'CUSTOMER_USER',
    email: 'demo@danakav.ir',
    firstName: 'کاربر',
    lastName: 'نمونه',
    name: 'کاربر نمونه',
    phone: '',
    customerId: entityId('CUSTOMER', CUSTOMER_ID),
    tenantId: entityId('TENANT', TENANT_ID),
    additionalInfo: { lang: 'fa_IR', userActivated: true, userCredentialsEnabled: true },
  };

  var ALARMS = [
    { name: 'دمای بالا — کوره القایی', severity: 'CRITICAL', type: 'HighTemperature', originator: 'NexIoT-OPCUA-01' },
    { name: 'افت راندمان پمپ تغذیه', severity: 'MAJOR', type: 'LowEfficiency', originator: 'HTTP-Machine-01' },
    { name: 'لرزش غیرعادی موتور', severity: 'MINOR', type: 'Vibration', originator: 'S7-PLC-01' },
    { name: 'قطع اتصال سنسور دما', severity: 'WARNING', type: 'NoData', originator: 'MQTT-Sensor-01' },
  ].map(function (def, index) {
    var device = DEVICES.find(function (d) {
      return d.name === def.originator;
    });
    var originator = device
      ? entityId('DEVICE', device.id)
      : entityId('DEVICE', uuidFrom(def.originator));
    return {
      id: entityId('ALARM', uuidFrom('alarm:' + def.name)),
      createdTime: Date.now() - (index + 1) * 3600000,
      name: def.name,
      type: def.type,
      severity: def.severity,
      status: 'ACTIVE_UNACK',
      acknowledged: false,
      cleared: false,
      startTs: Date.now() - (index + 1) * 3600000,
      endTs: Date.now(),
      originator: originator,
      originatorName: def.originator,
      details: null,
    };
  });
  function alarmData(alarm) {
    return Object.assign({}, alarm, {
      originatorName: alarm.originatorName,
      originatorLabel: alarm.originatorName,
      assignee: null,
      propagate: false,
      propagateToOwner: false,
      propagateRelationTypes: null,
    });
  }

  // -------------------------------------------------------------------------
  // Helpers.
  // -------------------------------------------------------------------------
  function jsonClone(value) {
    return value === null || value === undefined
      ? value
      : JSON.parse(JSON.stringify(value));
  }
  function ok(data) {
    return { data: jsonClone(data), status: 200, statusText: 'OK', headers: {}, config: {} };
  }
  function pageData(items) {
    return {
      data: jsonClone(items),
      hasNext: false,
      totalElements: items.length,
      totalPages: items.length > 0 ? 1 : 0,
    };
  }
  function delay(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }
  /** Minimal but complete /api/system/params so the UI shows no warnings. */
  function systemParams() {
    return {
      allowedDashboardIds: [],
      edgesSupportEnabled: false,
      hasRepository: false,
      iotHubBaseUrl: '',
      maxArgumentsPerCF: 10,
      maxDataPointsPerRollingArg: 1000,
      maxDatapointsLimit: 1000,
      maxDebugModeDurationMinutes: 15,
      maxRelatedEntitiesToReturnPerCFArgument: 100,
      maxRelationLevelPerCfArgument: 1,
      maxResourceSize: 10485760,
      minAllowedAggregationIntervalInSecForCF: 60,
      minAllowedDeduplicationIntervalInSecForCF: 1,
      minAllowedScheduledUpdateIntervalInSecForCF: 1,
      mobileQrEnabled: false,
      nullsOrderStrategy: 'default',
      persistDeviceStateToTelemetry: false,
      tbelEnabled: true,
      trendzSettings: { enabled: false, baseUrl: null, apiKey: null },
      userSettings: {},
      userTokenAccessEnabled: true,
      edqsEnabled: true,
    };
  }
  function pathOnly(url) {
    var value = String(url || '');
    var q = value.indexOf('?');
    if (q !== -1) value = value.slice(0, q);
    value = value.replace(/^https?:\/\/[^/]+/i, '');
    return value.replace(/\/+$/, '') || '/';
  }
  function parseBody(config) {
    try {
      return typeof config.data === 'string'
        ? JSON.parse(config.data)
        : config.data || {};
    } catch (error) {
      return {};
    }
  }
  function requestedKeys(params) {
    if (!params) return [];
    if (Array.isArray(params.key)) return params.key;
    if (typeof params.key === 'string') return params.key.split(',').filter(Boolean);
    if (typeof params.keys === 'string') return params.keys.split(',').filter(Boolean);
    return [];
  }

  // -------------------------------------------------------------------------
  // REST router.
  // -------------------------------------------------------------------------
  function fakeJwt() {
    var header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    var payload = btoa(
      JSON.stringify({
        sub: 'demo@danakav.ir',
        scopes: ['CUSTOMER_USER'],
        userId: USER_ID,
        exp: Math.floor(Date.now() / 1000) + 86400 * 30,
      }),
    );
    return header + '.' + payload + '.demo-signature';
  }
  function loginPair() {
    return { token: fakeJwt(), refreshToken: fakeJwt(), scope: 'CUSTOMER_USER' };
  }
  function unauthorized(config) {
    var error = new Error('نام کاربری یا گذرواژه نادرست است');
    error.response = {
      data: { errorCode: 10, message: 'Authentication failed', status: 401, timestamp: Date.now() },
      status: 401,
      statusText: 'Unauthorized',
      headers: {},
      config: config,
    };
    return error;
  }
  function isDemoCredentials(username, password) {
    var u = String(username || '').trim();
    return (
      (u === DEMO.username || u === 'demo@danakav.ir') &&
      String(password || '') === DEMO.password
    );
  }

  function route(method, path, params, body, config) {
    var url = pathOnly(path);
    var m = method.toLowerCase();

    // --- auth -------------------------------------------------------------
    if (m === 'post' && (url === '/auth/login' || url === '/api/auth/login')) {
      if (!isDemoCredentials(body.username, body.password)) throw unauthorized(config);
      return loginPair();
    }
    if (m === 'post' && (url === '/auth/token' || url === '/api/auth/token')) return loginPair();
    if (m === 'post' && url.endsWith('/auth/logout')) return null;
    if (m === 'get' && url.endsWith('/auth/user')) return CUSTOMER_USER;

    // --- customers --------------------------------------------------------
    if (m === 'get' && url.endsWith('/customer/' + CUSTOMER_ID)) return CUSTOMER;
    if (m === 'get' && /\/customer\/[^/]+\/users$/.test(url)) return pageData([CUSTOMER_USER]);
    if (m === 'get' && /\/customer\/[^/]+\/deviceInfos$/.test(url)) return pageData(DEVICES.map(deviceInfo));
    if (m === 'get' && /\/customer\/[^/]+\/devices$/.test(url)) return pageData(DEVICES.map(deviceEntity));
    if (m === 'get' && /\/customer\/[^/]+\/dashboards$/.test(url)) return pageData([]);

    // --- devices ----------------------------------------------------------
    if (m === 'get' && url.endsWith('/tenant/deviceInfos')) return pageData(DEVICES.map(deviceInfo));
    if (m === 'get' && url.endsWith('/tenant/devices')) return pageData(DEVICES.map(deviceEntity));
    if (m === 'get' && /\/device\/info\/[^/]+$/.test(url)) {
      var found = findDevice(url);
      return found ? deviceInfo(found) : null;
    }
    if (m === 'get' && /\/device\/[^/]+$/.test(url) && !url.endsWith('/credentials')) {
      var device = findDevice(url);
      if (device) return deviceEntity(device);
    }
    if (m === 'get' && url.endsWith('/deviceProfileInfos')) {
      return pageData(
        Object.keys(PROFILES).map(function (name) {
          return profileInfo(PROFILES[name]);
        }),
      );
    }
    if (m === 'get' && url.endsWith('/deviceProfileInfo/default')) {
      return profileInfo(PROFILES['Modbus RTU']);
    }
    if (m === 'get' && /\/deviceProfileInfo\/[^/]+$/.test(url)) {
      return profileInfo(PROFILES['Modbus RTU']);
    }
    if (m === 'get' && /\/deviceProfile\/[^/]+$/.test(url)) {
      return Object.assign(profileInfo(PROFILES['Modbus RTU']), {
        configuration: { type: 'DEFAULT' },
        defaultRuleChainId: null,
        defaultDashboardId: null,
        provisionType: 'DISABLED',
      });
    }

    // --- dashboards -------------------------------------------------------
    if (m === 'get' && url.endsWith('/tenant/dashboards')) return pageData([]);
    if (m === 'get' && /\/dashboard\/(info\/)?[^/]+$/.test(url)) return null;

    // --- alarms -----------------------------------------------------------
    if (m === 'get' && url.endsWith('/alarms')) return pageData(ALARMS.map(alarmData));
    if (m === 'get' && /\/alarm\/info\/[^/]+$/.test(url)) {
      var info = ALARMS.find(function (alarm) {
        return alarm.id.id === url.split('/').pop();
      });
      return info ? alarmData(info) : null;
    }
    if (m === 'get' && /\/alarm\/[A-Z_]+\/[^/]+$/.test(url)) return pageData(ALARMS.map(alarmData));
    if (m === 'post' && /\/alarm\/[^/]+\/(ack|clear|assign)/.test(url)) return null;

    // --- telemetry --------------------------------------------------------
    var tsMatch = /\/plugins\/telemetry\/([A-Z_]+)\/([^/]+)\/values\/timeseries$/.exec(url);
    if (m === 'get' && tsMatch) {
      var target = findDeviceById(tsMatch[2]);
      if (!target) return {};
      var keys = requestedKeys(params);
      if (keys.length === 0) keys = Object.keys(target.telemetry.series);
      var history =
        params &&
        params.startTs &&
        params.endTs &&
        params.endTs - params.startTs > 3600000;
      var source = history ? target.telemetry.history : target.telemetry.series;
      var out = {};
      keys.forEach(function (key) {
        if (source[key]) out[key] = source[key];
      });
      return out;
    }
    var attrMatch = /\/plugins\/telemetry\/([A-Z_]+)\/([^/]+)\/values\/attributes$/.exec(url);
    if (m === 'get' && attrMatch) {
      var now = Date.now();
      return {
        active: [{ lastUpdateTs: now, value: true }],
        lastActivityTime: [{ lastUpdateTs: now, value: now }],
        latitude: [{ lastUpdateTs: now, value: 35.71 }],
        longitude: [{ lastUpdateTs: now, value: 51.42 }],
      };
    }
    if (m === 'post' && /\/plugins\/telemetry\/[A-Z_]+\/[^/]+\/(timeseries|attributes)$/.test(url)) return null;

    // --- system -----------------------------------------------------------
    if (m === 'get' && url.endsWith('/system/params')) return systemParams();

    // --- misc -------------------------------------------------------------
    if (m === 'get' && url.endsWith('/components')) return { components: [] };
    if (m === 'get' && /\/relations\/info$/.test(url)) return pageData([]);
    if (m === 'get' && /\/alarm\/rules$/.test(url)) return pageData([]);

    return undefined;
  }

  function findDeviceById(id) {
    return DEVICES.find(function (device) {
      return device.id === id;
    });
  }
  function findDevice(url) {
    return findDeviceById(url.split('/').pop());
  }

  // -------------------------------------------------------------------------
  // REST mock — installed at the XMLHttpRequest level.
  //
  // The app's bundled axios instance is not exposed on `window`, so the mock
  // cannot swap `axios.defaults.adapter`. Instead every `XMLHttpRequest` to an
  // `/api/...` path is answered in-process; anything else is delegated to the
  // real XHR (there is nothing else in a static deploy, but this keeps the
  // behaviour obvious).
  // -------------------------------------------------------------------------
  function installXhrMock() {
    var NativeXHR = window.XMLHttpRequest;
    if (!NativeXHR) return;

    function MockXHR() {
      this.readyState = 0;
      this.status = 0;
      this.statusText = '';
      this.response = '';
      this.responseText = '';
      this.responseType = '';
      this.responseURL = '';
      this.responseXML = null;
      this.timeout = 0;
      this.withCredentials = false;
      this.upload = { addEventListener: function () {}, removeEventListener: function () {} };
      this.onreadystatechange = null;
      this.onload = null;
      this.onloadstart = null;
      this.onloadend = null;
      this.onprogress = null;
      this.onabort = null;
      this.onerror = null;
      this.ontimeout = null;
      this._method = 'GET';
      this._url = '';
      this._async = true;
      this._reqHeaders = {};
      this._respHeaders = '';
      this._respHeaderMap = {};
      this._aborted = false;
      this._native = null;
      this._listeners = {};
    }
    MockXHR.UNSENT = 0;
    MockXHR.OPENED = 1;
    MockXHR.HEADERS_RECEIVED = 2;
    MockXHR.LOADING = 3;
    MockXHR.DONE = 4;

    MockXHR.prototype._fire = function (type) {
      var handler = this['on' + type];
      if (typeof handler === 'function') {
        try {
          handler.call(this, { type: type });
        } catch (error) {
          /* ignore handler errors */
        }
      }
      var list = this._listeners[type];
      if (list) list.forEach(function (fn) { try { fn.call(this, { type: type }); } catch (e) {} }, this);
    };
    MockXHR.prototype.addEventListener = function (type, fn) {
      (this._listeners[type] = this._listeners[type] || []).push(fn);
    };
    MockXHR.prototype.removeEventListener = function (type, fn) {
      var list = this._listeners[type];
      if (list) this._listeners[type] = list.filter(function (item) { return item !== fn; });
    };
    MockXHR.prototype.open = function (method, url, async) {
      if (this._native) this._native.open(method, url, async);
      this._method = method;
      this._url = url;
      this._async = async !== false;
      this.readyState = 1;
    };
    MockXHR.prototype.setRequestHeader = function (name, value) {
      if (this._native) return this._native.setRequestHeader(name, value);
      this._reqHeaders[name] = value;
    };
    MockXHR.prototype.getResponseHeader = function (name) {
      if (this._native) return this._native.getResponseHeader(name);
      return this._respHeaderMap[String(name).toLowerCase()] || null;
    };
    MockXHR.prototype.getAllResponseHeaders = function () {
      if (this._native) return this._native.getAllResponseHeaders();
      return this._respHeaders;
    };
    MockXHR.prototype.abort = function () {
      this._aborted = true;
      this.readyState = 0;
      if (this._native) return this._native.abort();
      this._fire('abort');
      this._fire('loadend');
    };
    MockXHR.prototype.send = function (body) {
      var self = this;
      var path = pathOnly(this._url);
      if (path.indexOf('/api/') !== 0) return this._delegate(body);

      var params = {};
      var q = String(this._url).indexOf('?');
      if (q !== -1) {
        String(this._url).slice(q + 1).split('&').forEach(function (pair) {
          var kv = pair.split('=');
          if (!kv[0]) return;
          var key = decodeURIComponent(kv[0]);
          var value = decodeURIComponent((kv[1] || '').replace(/\+/g, ' '));
          if (params[key] === undefined) params[key] = value;
          else if (Array.isArray(params[key])) params[key].push(value);
          else params[key] = [params[key], value];
        });
      }
      var parsedBody = {};
      try {
        parsedBody = typeof body === 'string' ? JSON.parse(body) : body || {};
      } catch (error) {
        parsedBody = {};
      }

      setTimeout(function () {
        if (self._aborted) return;
        var status;
        var text;
        var statusText;
        try {
          var result = route(self._method, path, params, parsedBody, {});
          if (result === undefined) {
            self.readyState = 4;
            self.status = 404;
            self.statusText = 'Not Found';
            text = JSON.stringify({ error: 'not found', path: path });
          } else if (result === null) {
            status = 204;
            statusText = 'No Content';
            text = '';
          } else {
            status = 200;
            statusText = 'OK';
            text = JSON.stringify(jsonClone(result));
          }
        } catch (error) {
          status = (error && error.response && error.response.status) || 500;
          statusText = 'Error';
          text = JSON.stringify(
            (error && error.response && error.response.data) || { message: String(error) },
          );
        }
        if (self._aborted) return;
        if (status === undefined) { status = self.status; statusText = self.statusText; }
        self.status = status;
        self.statusText = statusText;
        self.responseText = text;
        self.response = text;
        self.responseURL = String(self._url);
        self._respHeaderMap = { 'content-type': 'application/json' };
        self._respHeaders = 'content-type: application/json\r\n';
        self.readyState = 4;
        self._fire('readystatechange');
        self._fire('load');
        self._fire('loadend');
      }, 20 + Math.random() * 60);
    };
    MockXHR.prototype._delegate = function (body) {
      var self = this;
      var native = new NativeXHR();
      this._native = native;
      native.onreadystatechange = function () {
        if (native.readyState === 4) {
          self.status = native.status;
          self.statusText = native.statusText;
          self.response = native.response;
          self.responseText = native.responseText;
          self.responseURL = native.responseURL;
        }
        self.readyState = native.readyState;
        self._fire('readystatechange');
      };
      native.onloadend = function () { self._fire('loadend'); };
      native.onload = function () { self._fire('load'); };
      native.onerror = function () { self._fire('error'); };
      native.onabort = function () { self._fire('abort'); };
      native.ontimeout = function () { self._fire('timeout'); };
      native.open(this._method, this._url, this._async);
      Object.keys(this._reqHeaders).forEach(function (key) {
        native.setRequestHeader(key, self._reqHeaders[key]);
      });
      native.send(body);
    };

    window.XMLHttpRequest = MockXHR;
  }

  // -------------------------------------------------------------------------
  // AI pipeline proxy (TSFM.ai + OpenRouter).
  //
  // The «تحلیل هوش مصنوعی» feature calls same-origin `/ai/llm/*` and
  // `/ai/tsfm/*` paths with the browser `fetch` API. The bundled nginx.conf
  // forwards those to the upstreams and injects the API keys (same pattern as
  // the repo's own frontend/docker/nginx.conf). When the site is served by a
  // plain static host instead, `fetch` falls back to calling the upstream
  // directly with the bundled key. TSFM.ai sends no CORS headers, so that
  // fallback only works for the LLM call — deploy the bundled nginx (or the
  // Dockerfile) for the full pipeline.
  // -------------------------------------------------------------------------
  function installFetchBridge() {
    if (typeof window.fetch !== 'function') return;
    var nativeFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      var path = pathOnly(url);
      if (path.indexOf('/ai/') !== 0) return nativeFetch(input, init);
      // Prefer the same-origin proxy: the bundled nginx.conf forwards /ai/* to
      // the upstream and injects the key (matching the repo's own deployment).
      // A plain static host without that proxy answers with the SPA HTML, so
      // fall back to calling the upstream directly with the bundled key.
      return nativeFetch(input, init)
        .then(function (response) {
          return ensureAiOk(nativeFetch, response, path, init);
        })
        .catch(function () {
          return proxyAi(nativeFetch, path, init, null);
        });
    };
  }

  /**
   * The same-origin proxy answers 200 with the SPA HTML when it is missing, and
   * OpenRouter returns a 503/429 envelope when the requested free model is
   * overloaded. Both must trigger the direct upstream fallback (and, for the
   * LLM, a second, more reliable model) rather than surfacing a raw error.
   */
  function ensureAiOk(nativeFetch, response, path, init) {
    var type = (response.headers.get('content-type') || '').toLowerCase();
    if (!response.ok || type.indexOf('application/json') === -1) {
      return proxyAi(nativeFetch, path, init, null);
    }
    return response
      .clone()
      .json()
      .then(function (data) {
        if (data && data.error) return proxyAi(nativeFetch, path, init, data.error);
        return response;
      })
      .catch(function () {
        return proxyAi(nativeFetch, path, init, null);
      });
  }

  function proxyAi(nativeFetch, path, init, priorError, modelOverride) {
    if (!DEMO.aiProxy) {
      return Promise.resolve(
        new Response(JSON.stringify({ error: 'ai-proxy-disabled' }), {
          status: 502,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    }

    var isLlm = path.indexOf('/ai/llm') === 0;
    var endpoint = isLlm
      ? DEMO.llmEndpoint || FALLBACK_LLM.endpoint
      : DEMO.tsfmEndpoint || FALLBACK_TSFM.endpoint;
    var key = isLlm
      ? DEMO.llmKey || FALLBACK_LLM.key
      : DEMO.tsfmKey || FALLBACK_TSFM.key;

    var body = (init && init.body) || '';
    // The built-in model can be rate-limited upstream; when the caller did not
    // pin one, rewrite it to a model that answers reliably.
    if (isLlm && !DEMO.llmModel) {
      body = withModel(body, modelOverride || FALLBACK_LLM.model);
    }

    var headers = new Headers((init && init.headers) || {});
    headers.set('Content-Type', 'application/json');
    headers.set('Authorization', 'Bearer ' + key);
    headers.set('HTTP-Referer', location.origin);
    headers.set('X-Title', 'danakav.ir demo');

    return nativeFetch(endpoint, {
      body: body,
      headers: headers,
      method: 'POST',
    }).then(function (response) {
      // Retry the LLM once with the backup model if the chosen one failed.
      if (
        isLlm &&
        !DEMO.llmModel &&
        FALLBACK_LLM.modelAlt &&
        FALLBACK_LLM.modelAlt !== FALLBACK_LLM.model
      ) {
        return response
          .clone()
          .json()
          .then(function (data) {
            if (data && data.error && priorError !== 'retried') {
              return proxyAi(
                nativeFetch,
                path,
                init,
                'retried',
                FALLBACK_LLM.modelAlt,
              ).catch(function () {
                return response;
              });
            }
            return response;
          })
          .catch(function () {
            return response;
          });
      }
      return response;
    });
  }

  /** Replace the `model` field of a JSON chat request body. */
  function withModel(body, model) {
    if (typeof body !== 'string' || body.length === 0) return body;
    try {
      var parsed = JSON.parse(body);
      parsed.model = model;
      return JSON.stringify(parsed);
    } catch (error) {
      return body;
    }
  }

  // -------------------------------------------------------------------------
  // WebSocket shim for /api/ws.
  // -------------------------------------------------------------------------
  function installWebSocketShim() {
    var NativeWebSocket = window.WebSocket;
    if (!NativeWebSocket) return;

    function DemoWebSocket(url, protocols) {
      var self = this;
      this.url = url;
      this.protocol = protocols || '';
      this.readyState = 0;
      this.bufferedAmount = 0;
      this.onopen = null;
      this.onmessage = null;
      this.onclose = null;
      this.onerror = null;
      this._subs = {};
      this._cmdId = 0;
      this._timers = [];
      this._closed = false;

      function emit(type, event) {
        var handler = self['on' + type];
        if (typeof handler === 'function') handler.call(self, event);
      }
      function message(payload) {
        emit('message', { data: JSON.stringify(payload) });
      }
      this.addEventListener = function (type, listener) {
        var key = 'on' + type;
        var previous = self[key];
        self[key] = function (event) {
          if (typeof previous === 'function') previous.call(self, event);
          listener.call(self, event);
        };
      };
      this.removeEventListener = function () {};
      this.dispatchEvent = function () {
        return true;
      };
      this.close = function () {
        self._closed = true;
        self.readyState = 3;
        self._timers.forEach(clearInterval);
        self._timers = [];
        emit('close', { code: 1000, reason: 'demo closed', wasClean: true });
      };
      // The app sends envelopes: { authCmd } to authenticate and
      // { cmds: [{ ...command, cmdId }] } to subscribe. Answers carry the same
      // cmdId so the store can route them to the right handler.
      this.send = function (raw) {
        var envelope;
        try {
          envelope = JSON.parse(raw);
        } catch (error) {
          return;
        }
        if (envelope.authCmd) return; // authentication ack is implicit
        if (!Array.isArray(envelope.cmds)) return;
        envelope.cmds.forEach(function (command) {
          if (
            command.type === 'MARK_NOTIFICATIONS_AS_READ' ||
            command.type === 'MARK_ALL_NOTIFICATIONS_AS_READ'
          ) {
            message({ cmdUpdateType: 'NOTIFICATIONS_COUNT', totalUnreadCount: 0, sequenceNumber: 1 });
            return;
          }
          var cmdId = command.cmdId;
          if (cmdId === undefined) {
            self._cmdId += 1;
            cmdId = self._cmdId;
          }
          if (command.unsubscribe || String(command.type).indexOf('_UNSUBSCRIBE') !== -1) {
            delete self._subs[cmdId];
            return;
          }
          self._subs[cmdId] = command;
          message(wsInitial(command, cmdId));
        });
      };

      this._start = function () {
        self.readyState = 1;
        emit('open', {});
        self._timers.push(
          setInterval(function () {
            if (self._closed) return;
            Object.keys(self._subs).forEach(function (key) {
              var command = self._subs[key];
              if (command.type === 'ENTITY_DATA' || command.type === 'ALARM_DATA') {
                message(wsInitial(command, Number(key)));
              }
            });
          }, 15000),
        );
      };

      setTimeout(this._start, 40);
    }
    DemoWebSocket.CONNECTING = 0;
    DemoWebSocket.OPEN = 1;
    DemoWebSocket.CLOSING = 2;
    DemoWebSocket.CLOSED = 3;

    window.WebSocket = function (url, protocols) {
      if (String(url).indexOf('/api/ws') !== -1) return new DemoWebSocket(url, protocols);
      return new NativeWebSocket(url, protocols);
    };
    window.WebSocket.CONNECTING = 0;
    window.WebSocket.OPEN = 1;
    window.WebSocket.CLOSING = 2;
    window.WebSocket.CLOSED = 3;
  }

  function wsInitial(command, cmdId) {
    switch (command.type) {
      case 'ENTITY_COUNT': {
        // The customer home asks for active / inactive / total device counts;
        // honour the `active` boolean filter when present.
        var filters = (command.query && command.query.keyFilters) || [];
        var wantsActive;
        for (var i = 0; i < filters.length; i += 1) {
          var filter = filters[i];
          if (filter && filter.key && filter.key.key === 'active') {
            wantsActive = filter.predicate && filter.predicate.value && filter.predicate.value.defaultValue;
          }
        }
        var count =
          wantsActive === undefined
            ? DEVICES.length
            : DEVICES.filter(function (device) {
                return device.active === wantsActive;
              }).length;
        return { cmdId: cmdId, cmdUpdateType: 'COUNT_DATA', count: count };
      }
      case 'ALARM_COUNT': {
        var query = command.query || {};
        var alarms = ALARMS;
        if (query.assigneeId) alarms = []; // nothing is assigned in the demo
        else if (query.severityList && query.severityList.length > 0) {
          alarms = ALARMS.filter(function (alarm) {
            return query.severityList.includes(alarm.severity);
          });
        }
        return { cmdId: cmdId, cmdUpdateType: 'ALARM_COUNT_DATA', count: alarms.length };
      }
      case 'ENTITY_DATA': {
        var data = DEVICES.map(function (device) {
          var latest = { ENTITY_FIELD: {}, ATTRIBUTE: {}, TIME_SERIES: {} };
          latest.ENTITY_FIELD.name = { value: device.name };
          latest.ENTITY_FIELD.label = { value: device.name };
          latest.ENTITY_FIELD.deviceProfileId = { value: device.profile };
          latest.ATTRIBUTE.active = { value: device.active };
          latest.ATTRIBUTE.lastActivityTime = { value: Date.now() - 60000 };
          // Spread the demo devices around Tehran so the map has content.
          latest.TIME_SERIES.latitude = { value: 35.7 + (hashSeed(device.name) % 100) / 1000 };
          latest.TIME_SERIES.longitude = { value: 51.4 + (hashSeed(device.name + 'x') % 100) / 1000 };
          return { entityId: entityId('DEVICE', device.id), latest: latest };
        });
        return {
          cmdId: cmdId,
          cmdUpdateType: 'ENTITY_DATA',
          data: { data: data, hasNext: false, totalElements: data.length, totalPages: 1 },
          allowedEntities: data.length,
          totalEntities: data.length,
        };
      }
      case 'ALARM_DATA': {
        return {
          cmdId: cmdId,
          cmdUpdateType: 'ALARM_DATA',
          data: pageData(ALARMS.map(alarmData)),
          allowedEntities: ALARMS.length,
          totalEntities: ALARMS.length,
        };
      }
      default: {
        return { cmdId: cmdId };
      }
    }
  }

  // -------------------------------------------------------------------------
  // Login hint (demo credentials) — a small floating chip on the login page.
  // -------------------------------------------------------------------------
  function installLoginHint() {
    if (document.getElementById('danakav-demo-hint')) return;
    var hint = document.createElement('div');
    hint.id = 'danakav-demo-hint';
    hint.dir = 'rtl';
    hint.innerHTML =
      '<span style="opacity:.75">ورود دمو</span>' +
      '<b style="direction:ltr;unicode-bidi:embed">' + DEMO.username + ' / ' + DEMO.password + '</b>';
    hint.style.cssText = [
      'position:fixed',
      'inset-block-end:16px',
      'inset-inline-start:16px',
      'z-index:2147483647',
      'display:flex',
      'gap:8px',
      'align-items:center',
      'padding:8px 14px',
      'border-radius:999px',
      'background:#0f172a',
      'color:#e6edf7',
      'font:600 12px/1 Vazirmatn,system-ui,sans-serif',
      'box-shadow:0 8px 24px rgba(0,0,0,.25)',
      'pointer-events:none',
    ].join(';');
    document.body.appendChild(hint);
  }

  // -------------------------------------------------------------------------
  // Boot.
  // -------------------------------------------------------------------------
  installXhrMock();
  installFetchBridge();
  installWebSocketShim();

  // Deterministic first paint: land on the marketing page, not on a dashboard.
  try {
    var initial = location.hash.replace(/^#/, '');
    var firstVisit = sessionStorage.getItem('danakav-visited') !== '1';
    if (firstVisit || initial === '' || initial === '/') {
      sessionStorage.setItem('danakav-visited', '1');
      if (initial !== '/landing') {
        location.replace(location.pathname + location.search + '#/landing');
      }
    }
  } catch (error) {
    /* storage may be unavailable; the app's own default route still applies. */
  }

  // Show the credential hint whenever the login page is on screen.
  function watchRoute() {
    if (location.hash.indexOf('#/auth/login') === 0) installLoginHint();
  }
  window.addEventListener('hashchange', watchRoute);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', watchRoute);
  } else {
    watchRoute();
  }
  setInterval(watchRoute, 800);
})();
