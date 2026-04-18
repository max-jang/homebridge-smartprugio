// index.js (homebridge-smartprugio)
// 전등(LIGHTS) + 보일러(HEATING) + 에어컨(AIRCON) 액세서리를 한 파일에 통합
// 보일러는 POWER + HTEMPERATURE만 지원(모드 제어 없음)
// Thermostat UI의 Cool/Auto는 지원하지 않으므로 HEAT로 강제
// 과도한 요청을 막기 위해 디바운스를 적용

const axios = require("axios");

module.exports = (homebridge) => {
  const { Service, Characteristic } = homebridge.hap;

  // 기본 API 설정값
  const DEFAULT_BASE_URL = "https://svc.smartprugio.com:18888";
  const DEFAULT_APP_VERSION = "1.7.0-v84";
  const DEFAULT_USER_AGENT = "Smart Home/24";

  // API 요청에 필요한 헤더 구성
  function buildHeaders(appVersion, userAgent, token, auth) {
    if (!token || !auth) {
      throw new Error("Missing token/auth. Set config or env variables.");
    }
    return {
      app_version: appVersion || DEFAULT_APP_VERSION,
      "User-Agent": userAgent || DEFAULT_USER_AGENT,
      Accept: "application/json",
      "Accept-Language": "en-US,en;q=0.9",
      token,
      Authorization: auth,
      Connection: "keep-alive",
      "Content-Type": "application/json",
    };
  }

  // 최소 간격 내 중복 제어를 막는 간단한 디바운서
  class Debouncer {
    constructor(minIntervalMs = 600) {
      this.minIntervalMs = minIntervalMs;
      this.lastAt = 0;
    }
    allow() {
      const now = Date.now();
      if (now - this.lastAt < this.minIntervalMs) return false;
      this.lastAt = now;
      return true;
    }
  }

  // -------------------------
  // 액세서리: 전등
  // -------------------------
  class SmartPrugioLight {
        constructor(log, config) {
          this.log = log;
          this.name = config.name;
          // 전등 장치 ID 예시: "Lt03_pow01"
          this.deviceId = config.deviceId;
          this.baseUrl = config.baseUrl || DEFAULT_BASE_URL;
          this.appVersion = config.appVersion || DEFAULT_APP_VERSION;
          this.userAgent = config.userAgent || DEFAULT_USER_AGENT;
          this.token = config.token || process.env.SMARTPRUGIO_TOKEN;
          this.auth = config.auth || process.env.SMARTPRUGIO_AUTH;

          // UI 표시용 캐시(통신 실패 시 마지막 상태 유지)
          this.cachedOn = false;
          this.lastStateAt = 0;
          this.cacheMaxAgeMs = config.cacheMaxAgeMs ?? 900;
          this.controlSyncWindowMs = config.controlSyncWindowMs ?? 2200;
          this.pendingPower = null;
          this.pendingPowerUntil = 0;
          this.refreshPromise = null;
          this.debouncer = new Debouncer(config.minControlIntervalMs ?? 600);

          // 주기적 폴링(0이면 비활성화)
          this.pollIntervalSec = config.pollIntervalSec ?? 10;
          if (this.pollIntervalSec > 0) {
            setInterval(
                () => this.refreshState().catch(() => {}),
                this.pollIntervalSec * 1000
            );
          }

          // 초기 상태를 빠르게 확보
          setTimeout(() => this.refreshState().catch(() => {}), 300);

          this.log(`Initializing SmartPrugioLight accessory...`);
        }

        getServices() {
          this.informationService = new Service.AccessoryInformation()
              .setCharacteristic(Characteristic.Manufacturer, "SmartPrugio")
              .setCharacteristic(Characteristic.Model, "LIGHTS")
              .setCharacteristic(Characteristic.SerialNumber, this.deviceId);

          this.service = new Service.Lightbulb(this.name);

          this.service
              .getCharacteristic(Characteristic.On)
              .onGet(this.handleGetOn.bind(this))
              .onSet(this.handleSetOn.bind(this));

          return [this.informationService, this.service];
        }

        // 전등 상태 목록 조회
        async fetchLights() {
          const url = `${this.baseUrl}/v1/control/device?certf_tp_cd=KAKAO&ctl_tp_cd=LIGHTS`;
          const res = await axios.get(url, {
            headers: buildHeaders(
                this.appVersion,
                this.userAgent,
                this.token,
                this.auth
            ),
            timeout: 8000,
          });
          return res.data;
        }

        // 전등 목록에서 현재 장치의 POWER 상태만 추출
        extractPower(lightsPayload) {
          const groups = lightsPayload?.[0]?.device_grp_list || [];
          for (const g of groups) {
            for (const d of g.device_list || []) {
              if (d.device_id === this.deviceId) {
                const powerAttr = (d.device_attr_list || []).find(
                    (a) => a.device_attr_cd === "POWER"
                );
                // "ON" | "OFF" | "-"
                return powerAttr?.attr_cont;
              }
            }
          }
          return undefined;
        }

        // HomeKit에서 전등 상태 조회 시 호출
        async handleGetOn() {
          const stale = Date.now() - this.lastStateAt > this.cacheMaxAgeMs;
          if (stale) this.refreshState().catch(() => {});
          return this.cachedOn;
        }

        // HomeKit에서 전등 상태 변경 시 호출
        async handleSetOn(value) {
          const nextOn = !!value;
          this.cachedOn = nextOn;
          this.pendingPower = nextOn;
          this.pendingPowerUntil = Date.now() + this.controlSyncWindowMs;
          this.service?.updateCharacteristic(Characteristic.On, this.cachedOn);

          if (!this.debouncer.allow()) {
            // 요청 간격이 너무 짧으면 캐시를 유지하고 짧게 재조회 예약
            setTimeout(() => this.refreshState().catch(() => {}), 250);
            return;
          }

          // 전등 POWER 제어 요청
          const url = `${this.baseUrl}/v1/control/device`;
          const payload = {
            certf_tp_cd: "KAKAO",
            ctl_tp_cd: "LIGHTS",
            device_tp_cd: "LIGHTS",
            device_id: this.deviceId,
            device_attr_list: [
              { device_attr_cd: "POWER", set_cont: nextOn ? "ON" : "OFF" },
            ],
          };

          try {
            const res = await axios.post(url, payload, {
              headers: buildHeaders(
                  this.appVersion,
                  this.userAgent,
                  this.token,
                  this.auth
              ),
              timeout: 5000,
            });
            this.log(`LIGHTS 제어 접수: ${JSON.stringify(res.data)}`);
          } finally {
            // 제어 결과와 무관하게 다단계 재조회(서버 반영 지연/실패 대응)
            setTimeout(() => this.refreshState().catch(() => {}), 150);
            setTimeout(() => this.refreshState().catch(() => {}), 450);
            setTimeout(() => this.refreshState().catch(() => {}), 1000);
          }
        }

        // 전등 상태를 강제로 재조회하여 캐시/표시 동기화
        async refreshState() {
          if (this.refreshPromise) return this.refreshPromise;

          this.refreshPromise = (async () => {
          try {
            const payload = await this.fetchLights();
            const v = this.extractPower(payload);
            this.lastStateAt = Date.now();

            if (v === "ON" || v === "OFF") {
              const serverOn = v === "ON";
              const pending =
                  this.pendingPower !== null &&
                  Date.now() < this.pendingPowerUntil &&
                  serverOn !== this.pendingPower;

              if (!pending) {
                this.cachedOn = serverOn;
                if (
                    this.pendingPower !== null &&
                    serverOn === this.pendingPower
                ) {
                  this.pendingPower = null;
                }
              }
            }

            this.service?.updateCharacteristic(Characteristic.On, this.cachedOn);
          } catch {
            // 폴링 실패는 무시(다음 주기에 재시도)
          }
          })();

          try {
            await this.refreshPromise;
          } finally {
            this.refreshPromise = null;
          }
        }
      }

  homebridge.registerAccessory(
      "homebridge-smartprugio",
      "SmartPrugioLight",
      SmartPrugioLight
  );

  // -------------------------
  // 액세서리: 보일러(난방)
  // - 모드 제어 없음
  // - POWER + HTEMPERATURE만 사용
  // - Cool/Auto는 HEAT로 강제
  // -------------------------
  class SmartPrugioThermostat {
        constructor(log, config) {
          this.log = log;
          this.name = config.name;
          // 보일러 장치 ID 예시: "Ht03"
          this.deviceId = config.deviceId;
          this.baseUrl = config.baseUrl || DEFAULT_BASE_URL;
          this.appVersion = config.appVersion || DEFAULT_APP_VERSION;
          this.userAgent = config.userAgent || DEFAULT_USER_AGENT;
          this.token = config.token || process.env.SMARTPRUGIO_TOKEN;
          this.auth = config.auth || process.env.SMARTPRUGIO_AUTH;

          this.debouncer = new Debouncer(config.minControlIntervalMs ?? 600);

          // UI 안정성을 위한 캐시(통신 실패 시 마지막 값 유지)
          this.cachedCurrentTemp = 20;
          this.cachedTargetTemp = 22;
          this.cachedActive = false;
          this.lastStateAt = 0;
          this.cacheMaxAgeMs = config.cacheMaxAgeMs ?? 900;
          this.controlSyncWindowMs = config.controlSyncWindowMs ?? 2200;
          this.pendingActive = null;
          this.pendingActiveUntil = 0;
          this.pendingTargetTemp = null;
          this.pendingTargetTempUntil = 0;
          this.refreshPromise = null;

          // 주기적 폴링(0이면 비활성화)
          this.pollIntervalSec = config.pollIntervalSec ?? 10;
          if (this.pollIntervalSec > 0) {
            setInterval(
                () => this.refreshState().catch(() => {}),
                this.pollIntervalSec * 1000
            );
          }

          // 초기 상태를 빠르게 확보
          setTimeout(() => this.refreshState().catch(() => {}), 300);

          this.log(`Initializing SmartPrugioThermostat accessory...`);
        }

        getServices() {
          this.informationService = new Service.AccessoryInformation()
              .setCharacteristic(Characteristic.Manufacturer, "SmartPrugio")
              .setCharacteristic(Characteristic.Model, "HEATING")
              .setCharacteristic(Characteristic.SerialNumber, this.deviceId);

          this.service = new Service.Thermostat(this.name);

          // 현재 온도
          this.service
              .getCharacteristic(Characteristic.CurrentTemperature)
              .onGet(this.handleGetCurrentTemp.bind(this));

          // 목표 온도
          this.service
              .getCharacteristic(Characteristic.TargetTemperature)
              .setProps({ minValue: 5, maxValue: 40, minStep: 1 })
              .onGet(this.handleGetTargetTemp.bind(this))
              .onSet(this.handleSetTargetTemp.bind(this));

          // 난방 ON/OFF
          this.service
              .getCharacteristic(Characteristic.Active)
              .onGet(this.handleGetActive.bind(this))
              .onSet(this.handleSetActive.bind(this));

          // 난방/냉방 모드(논리적으로 OFF/HEAT만 사용, UI는 COOL/AUTO 표시 가능)
          this.service
              .getCharacteristic(Characteristic.TargetHeatingCoolingState)
              .onGet(this.handleGetTargetHcState.bind(this))
              .onSet(this.handleSetTargetHcState.bind(this));

          // 현재 동작 상태
          this.service
              .getCharacteristic(Characteristic.CurrentHeatingCoolingState)
              .onGet(this.handleGetCurrentHcState.bind(this));

          return [this.informationService, this.service];
        }

        // 보일러 상태 목록 조회
        async fetchHeating() {
          const url = `${this.baseUrl}/v1/control/device?certf_tp_cd=KAKAO&ctl_tp_cd=HEATING`;
          const res = await axios.get(url, {
            headers: buildHeaders(
                this.appVersion,
                this.userAgent,
                this.token,
                this.auth
            ),
            timeout: 8000,
          });
          return res.data;
        }

        // 보일러 목록에서 현재 장치의 주요 속성만 추출
        extractAttrs(heatingPayload) {
          const groups = heatingPayload?.[0]?.device_grp_list || [];
          for (const g of groups) {
            for (const d of g.device_list || []) {
              if (d.device_id === this.deviceId) {
                const attrs = d.device_attr_list || [];
                const get = (code) =>
                    attrs.find((a) => a.device_attr_cd === code)?.attr_cont;
                return {
                  CT: get("CTEMPERATURE"),
                  HT: get("HTEMPERATURE"),
                  POWER: get("POWER"),
                };
              }
            }
          }
          return null;
        }

        // 여러 속성(POWER/HTEMPERATURE)을 한 번에 제어
        async controlMany(attrPairs) {
          const url = `${this.baseUrl}/v1/control/device`;
          const payload = {
            certf_tp_cd: "KAKAO",
            ctl_tp_cd: "HEATING",
            device_tp_cd: "HEATING",
            device_id: this.deviceId,
            device_attr_list: attrPairs.map(([device_attr_cd, set_cont]) => ({
              device_attr_cd,
              set_cont: String(set_cont),
            })),
          };

          const res = await axios.post(url, payload, {
            headers: buildHeaders(
                this.appVersion,
                this.userAgent,
                this.token,
                this.auth
            ),
            timeout: 5000,
          });

          this.log(`HEATING 제어 접수: ${JSON.stringify(res.data)}`);
        }

        // HomeKit에서 현재 온도 조회 시 호출
        async handleGetCurrentTemp() {
          const stale = Date.now() - this.lastStateAt > this.cacheMaxAgeMs;
          if (stale) this.refreshState().catch(() => {});
          return this.cachedCurrentTemp;
        }

        // HomeKit에서 목표 온도 조회 시 호출
        async handleGetTargetTemp() {
          const stale = Date.now() - this.lastStateAt > this.cacheMaxAgeMs;
          if (stale) this.refreshState().catch(() => {});
          return this.cachedTargetTemp;
        }

        // HomeKit에서 목표 온도 변경 시 호출
        async handleSetTargetTemp(value) {
          const v = Math.round(Number(value));
          if (!Number.isFinite(v)) return;

          this.cachedTargetTemp = v;
          this.cachedActive = true;
          this.pendingTargetTemp = v;
          this.pendingTargetTempUntil = Date.now() + this.controlSyncWindowMs;
          this.pendingActive = true;
          this.pendingActiveUntil = Date.now() + this.controlSyncWindowMs;
          this.service?.updateCharacteristic(
              Characteristic.TargetTemperature,
              this.cachedTargetTemp
          );
          this.service?.updateCharacteristic(Characteristic.Active, 1);
          this.service?.updateCharacteristic(
              Characteristic.TargetHeatingCoolingState,
              Characteristic.TargetHeatingCoolingState.HEAT
          );
          this.service?.updateCharacteristic(
              Characteristic.CurrentHeatingCoolingState,
              Characteristic.CurrentHeatingCoolingState.HEAT
          );

          if (!this.debouncer.allow()) {
            setTimeout(() => this.refreshState().catch(() => {}), 250);
            return;
          }

          // 한 번의 요청으로 POWER=ON + HTEMPERATURE 설정
          try {
            await this.controlMany([
              ["POWER", "ON"],
              ["HTEMPERATURE", v],
            ]);
          } finally {
            // 제어 결과와 무관하게 다단계 재조회(서버 반영 지연/실패 대응)
            setTimeout(() => this.refreshState().catch(() => {}), 150);
            setTimeout(() => this.refreshState().catch(() => {}), 450);
            setTimeout(() => this.refreshState().catch(() => {}), 1000);
          }
        }

        // HomeKit에서 난방 ON/OFF 조회 시 호출
        async handleGetActive() {
          const stale = Date.now() - this.lastStateAt > this.cacheMaxAgeMs;
          if (stale) this.refreshState().catch(() => {});
          return this.cachedActive ? 1 : 0;
        }

        // HomeKit에서 난방 ON/OFF 변경 시 호출
        async handleSetActive(value) {
          const on = Number(value) === 1;
          this.cachedActive = on;
          this.pendingActive = on;
          this.pendingActiveUntil = Date.now() + this.controlSyncWindowMs;
          this.service?.updateCharacteristic(Characteristic.Active, on ? 1 : 0);
          this.service?.updateCharacteristic(
              Characteristic.TargetHeatingCoolingState,
              on
                  ? Characteristic.TargetHeatingCoolingState.HEAT
                  : Characteristic.TargetHeatingCoolingState.OFF
          );
          this.service?.updateCharacteristic(
              Characteristic.CurrentHeatingCoolingState,
              on
                  ? Characteristic.CurrentHeatingCoolingState.HEAT
                  : Characteristic.CurrentHeatingCoolingState.OFF
          );

          if (!this.debouncer.allow()) {
            setTimeout(() => this.refreshState().catch(() => {}), 250);
            return;
          }

          try {
            if (on) {
              const target = Math.max(5, Math.min(40, this.cachedTargetTemp));
              // 에어컨과 동일하게 ON 시 현재 목표온도를 함께 전송
              await this.controlMany([
                ["POWER", "ON"],
                ["HTEMPERATURE", target],
              ]);
            } else {
              // OFF는 POWER만 전송
              await this.controlMany([["POWER", "OFF"]]);
            }

            // 켜질 때 UI 상태를 HEAT로 즉시 강제
            if (on) {
              this.service?.updateCharacteristic(
                  Characteristic.TargetHeatingCoolingState,
                  Characteristic.TargetHeatingCoolingState.HEAT
              );
            }
          } finally {
            // 제어 결과와 무관하게 다단계 재조회(서버 반영 지연/실패 대응)
            setTimeout(() => this.refreshState().catch(() => {}), 150);
            setTimeout(() => this.refreshState().catch(() => {}), 450);
            setTimeout(() => this.refreshState().catch(() => {}), 1000);
          }
        }

        // HomeKit에서 목표 모드 조회 시 호출(OFF/HEAT만 제공)
        async handleGetTargetHcState() {
          return this.cachedActive
              ? Characteristic.TargetHeatingCoolingState.HEAT
              : Characteristic.TargetHeatingCoolingState.OFF;
        }

        // HomeKit에서 목표 모드 변경 시 호출
        async handleSetTargetHcState(value) {
          const v = Number(value);

          // OFF는 그대로 유지
          if (v === Characteristic.TargetHeatingCoolingState.OFF) {
            await this.handleSetActive(0);
            return;
          }

          // HEAT/COOL/AUTO 모두 HEAT로 처리(냉방/자동 미지원)
          await this.handleSetActive(1);

          // UI를 HEAT로 강제
          this.service?.updateCharacteristic(
              Characteristic.TargetHeatingCoolingState,
              Characteristic.TargetHeatingCoolingState.HEAT
          );
        }

        // HomeKit에서 현재 동작 상태 조회 시 호출
        async handleGetCurrentHcState() {
          return this.cachedActive
              ? Characteristic.CurrentHeatingCoolingState.HEAT
              : Characteristic.CurrentHeatingCoolingState.OFF;
        }

        // 보일러 상태를 강제로 재조회하여 캐시/표시 동기화
        async refreshState() {
          if (this.refreshPromise) return this.refreshPromise;

          this.refreshPromise = (async () => {
          try {
            const payload = await this.fetchHeating();
            const a = this.extractAttrs(payload);
            if (!a) return;
            this.lastStateAt = Date.now();

            const ht = Number(a.HT);
            if (Number.isFinite(ht) && ht >= 5 && ht <= 40) {
              const pendingTarget =
                  this.pendingTargetTemp !== null &&
                  Date.now() < this.pendingTargetTempUntil &&
                  ht !== this.pendingTargetTemp;
              if (!pendingTarget) {
                this.cachedTargetTemp = ht;
                if (
                    this.pendingTargetTemp !== null &&
                    ht === this.pendingTargetTemp
                ) {
                  this.pendingTargetTemp = null;
                }
              }
            }

            const ct = Number(a.CT);
            if (Number.isFinite(ct) && ct > 0) this.cachedCurrentTemp = ct;

            if (a.POWER === "ON" || a.POWER === "OFF") {
              const serverActive = a.POWER === "ON";
              const pendingActive =
                  this.pendingActive !== null &&
                  Date.now() < this.pendingActiveUntil &&
                  serverActive !== this.pendingActive;
              if (!pendingActive) {
                this.cachedActive = serverActive;
                if (
                    this.pendingActive !== null &&
                    serverActive === this.pendingActive
                ) {
                  this.pendingActive = null;
                }
              }
            }

            this.service?.updateCharacteristic(
                Characteristic.TargetTemperature,
                this.cachedTargetTemp
            );
            this.service?.updateCharacteristic(
                Characteristic.CurrentTemperature,
                this.cachedCurrentTemp
            );
            this.service?.updateCharacteristic(
                Characteristic.Active,
                this.cachedActive ? 1 : 0
            );
            this.service?.updateCharacteristic(
                Characteristic.CurrentHeatingCoolingState,
                this.cachedActive
                    ? Characteristic.CurrentHeatingCoolingState.HEAT
                    : Characteristic.CurrentHeatingCoolingState.OFF
            );
            this.service?.updateCharacteristic(
                Characteristic.TargetHeatingCoolingState,
                this.cachedActive
                    ? Characteristic.TargetHeatingCoolingState.HEAT
                    : Characteristic.TargetHeatingCoolingState.OFF
            );
          } catch {
            // 폴링 실패는 무시(다음 주기에 재시도)
          }
          })();

          try {
            await this.refreshPromise;
          } finally {
            this.refreshPromise = null;
          }
        }
      }

  homebridge.registerAccessory(
      "homebridge-smartprugio",
      "SmartPrugioThermostat",
      SmartPrugioThermostat
  );

  // -------------------------
  // 액세서리: 에어컨디셔너(냉방)
  // - 모드 제어 없음
  // - POWER + HTEMPERATURE만 사용
  // - Heat/Auto는 COOL로 강제
  // -------------------------
  class SmartPrugioAirConditioner {
        constructor(log, config) {
          this.log = log;
          this.name = config.name;
          // 에어컨 장치 ID 예시: "Ac03"
          this.deviceId = config.deviceId;
          this.baseUrl = config.baseUrl || DEFAULT_BASE_URL;
          this.appVersion = config.appVersion || DEFAULT_APP_VERSION;
          this.userAgent = config.userAgent || DEFAULT_USER_AGENT;
          this.token = config.token || process.env.SMARTPRUGIO_TOKEN;
          this.auth = config.auth || process.env.SMARTPRUGIO_AUTH;

          this.debouncer = new Debouncer(config.minControlIntervalMs ?? 600);

          // UI 안정성을 위한 캐시(통신 실패 시 마지막 값 유지)
          this.cachedCurrentTemp = 24;
          this.cachedTargetTemp = 24;
          this.cachedActive = false;
          this.lastStateAt = 0;
          this.cacheMaxAgeMs = config.cacheMaxAgeMs ?? 900;
          this.controlSyncWindowMs = config.controlSyncWindowMs ?? 2200;
          this.pendingActive = null;
          this.pendingActiveUntil = 0;
          this.pendingTargetTemp = null;
          this.pendingTargetTempUntil = 0;
          this.refreshPromise = null;

          // 주기적 폴링(0이면 비활성화)
          this.pollIntervalSec = config.pollIntervalSec ?? 10;
          if (this.pollIntervalSec > 0) {
            setInterval(
                () => this.refreshState().catch(() => {}),
                this.pollIntervalSec * 1000
            );
          }

          // 초기 상태를 빠르게 확보
          setTimeout(() => this.refreshState().catch(() => {}), 300);

          this.log(`Initializing SmartPrugioAirConditioner accessory...`);
        }

        getServices() {
          this.informationService = new Service.AccessoryInformation()
              .setCharacteristic(Characteristic.Manufacturer, "SmartPrugio")
              .setCharacteristic(Characteristic.Model, "AIRCON")
              .setCharacteristic(Characteristic.SerialNumber, this.deviceId);

          this.service = new Service.Thermostat(this.name);

          // 현재 온도
          this.service
              .getCharacteristic(Characteristic.CurrentTemperature)
              .onGet(this.handleGetCurrentTemp.bind(this));

          // 목표 온도
          this.service
              .getCharacteristic(Characteristic.TargetTemperature)
              .setProps({ minValue: 18, maxValue: 30, minStep: 1 })
              .onGet(this.handleGetTargetTemp.bind(this))
              .onSet(this.handleSetTargetTemp.bind(this));

          // 냉방 ON/OFF
          this.service
              .getCharacteristic(Characteristic.Active)
              .onGet(this.handleGetActive.bind(this))
              .onSet(this.handleSetActive.bind(this));

          // 냉난방 모드(논리적으로 OFF/COOL만 사용, UI는 HEAT/AUTO 표시 가능)
          this.service
              .getCharacteristic(Characteristic.TargetHeatingCoolingState)
              .onGet(this.handleGetTargetHcState.bind(this))
              .onSet(this.handleSetTargetHcState.bind(this));

          // 현재 동작 상태
          this.service
              .getCharacteristic(Characteristic.CurrentHeatingCoolingState)
              .onGet(this.handleGetCurrentHcState.bind(this));

          return [this.informationService, this.service];
        }

        // 에어컨 상태 목록 조회
        async fetchAirConditioner() {
          const url = `${this.baseUrl}/v1/control/device?certf_tp_cd=KAKAO&ctl_tp_cd=AIRCON`;
          const res = await axios.get(url, {
            headers: buildHeaders(
                this.appVersion,
                this.userAgent,
                this.token,
                this.auth
            ),
            timeout: 8000,
          });
          return res.data;
        }

        // 에어컨 목록에서 현재 장치의 주요 속성만 추출
        extractAttrs(airConditionerPayload) {
          const groups = airConditionerPayload?.[0]?.device_grp_list || [];
          for (const g of groups) {
            for (const d of g.device_list || []) {
              if (d.device_id === this.deviceId) {
                const attrs = d.device_attr_list || [];
                const get = (code) =>
                    attrs.find((a) => a.device_attr_cd === code)?.attr_cont;
                return {
                  CT: get("CTEMPERATURE"),
                  HT: get("HTEMPERATURE"),
                  POWER: get("POWER"),
                };
              }
            }
          }
          return null;
        }

        // 여러 속성(POWER/HTEMPERATURE)을 한 번에 제어
        async controlMany(attrPairs) {
          const url = `${this.baseUrl}/v1/control/device`;
          const payload = {
            certf_tp_cd: "KAKAO",
            ctl_tp_cd: "AIRCON",
            device_tp_cd: "AIRCON",
            device_id: this.deviceId,
            device_attr_list: attrPairs.map(([device_attr_cd, set_cont]) => ({
              device_attr_cd,
              set_cont: String(set_cont),
            })),
          };

          const res = await axios.post(url, payload, {
            headers: buildHeaders(
                this.appVersion,
                this.userAgent,
                this.token,
                this.auth
            ),
            timeout: 5000,
          });

          this.log(`AIRCON 제어 접수: ${JSON.stringify(res.data)}`);
        }

        // HomeKit에서 현재 온도 조회 시 호출
        async handleGetCurrentTemp() {
          const stale = Date.now() - this.lastStateAt > this.cacheMaxAgeMs;
          if (stale) this.refreshState().catch(() => {});
          return this.cachedCurrentTemp;
        }

        // HomeKit에서 목표 온도 조회 시 호출
        async handleGetTargetTemp() {
          const stale = Date.now() - this.lastStateAt > this.cacheMaxAgeMs;
          if (stale) this.refreshState().catch(() => {});
          return this.cachedTargetTemp;
        }

        // HomeKit에서 목표 온도 변경 시 호출
        async handleSetTargetTemp(value) {
          const v = Math.round(Number(value));
          if (!Number.isFinite(v)) return;

          this.cachedTargetTemp = Math.max(18, Math.min(30, v));
          this.cachedActive = true;
          this.pendingTargetTemp = this.cachedTargetTemp;
          this.pendingTargetTempUntil = Date.now() + this.controlSyncWindowMs;
          this.pendingActive = true;
          this.pendingActiveUntil = Date.now() + this.controlSyncWindowMs;
          this.service?.updateCharacteristic(
              Characteristic.TargetTemperature,
              this.cachedTargetTemp
          );
          this.service?.updateCharacteristic(Characteristic.Active, 1);
          this.service?.updateCharacteristic(
              Characteristic.TargetHeatingCoolingState,
              Characteristic.TargetHeatingCoolingState.COOL
          );
          this.service?.updateCharacteristic(
              Characteristic.CurrentHeatingCoolingState,
              Characteristic.CurrentHeatingCoolingState.COOL
          );

          if (!this.debouncer.allow()) {
            setTimeout(() => this.refreshState().catch(() => {}), 250);
            return;
          }

          try {
            // 한 번의 요청으로 POWER=ON + HTEMPERATURE 설정
            await this.controlMany([
              ["POWER", "ON"],
              ["HTEMPERATURE", this.cachedTargetTemp],
            ]);
          } finally {
            // 제어 결과와 무관하게 다단계 재조회(서버 반영 지연/실패 대응)
            setTimeout(() => this.refreshState().catch(() => {}), 150);
            setTimeout(() => this.refreshState().catch(() => {}), 450);
            setTimeout(() => this.refreshState().catch(() => {}), 1000);
          }
        }

        // HomeKit에서 냉방 ON/OFF 조회 시 호출
        async handleGetActive() {
          const stale = Date.now() - this.lastStateAt > this.cacheMaxAgeMs;
          if (stale) this.refreshState().catch(() => {});
          return this.cachedActive ? 1 : 0;
        }

        // HomeKit에서 냉방 ON/OFF 변경 시 호출
        async handleSetActive(value) {
          const on = Number(value) === 1;
          this.cachedActive = on;
          this.pendingActive = on;
          this.pendingActiveUntil = Date.now() + this.controlSyncWindowMs;
          this.service?.updateCharacteristic(Characteristic.Active, on ? 1 : 0);
          this.service?.updateCharacteristic(
              Characteristic.TargetHeatingCoolingState,
              on
                  ? Characteristic.TargetHeatingCoolingState.COOL
                  : Characteristic.TargetHeatingCoolingState.OFF
          );
          this.service?.updateCharacteristic(
              Characteristic.CurrentHeatingCoolingState,
              on
                  ? Characteristic.CurrentHeatingCoolingState.COOL
                  : Characteristic.CurrentHeatingCoolingState.OFF
          );

          if (!this.debouncer.allow()) {
            setTimeout(() => this.refreshState().catch(() => {}), 250);
            return;
          }

          try {
            if (on) {
              // 전원 ON 시 현재 목표온도를 함께 전송
              await this.controlMany([
                ["POWER", "ON"],
                ["HTEMPERATURE", this.cachedTargetTemp],
              ]);
            } else {
              // 전원 OFF는 POWER만 전송
              await this.controlMany([["POWER", "OFF"]]);
            }

            // 켜질 때 UI 상태를 COOL로 즉시 강제
            if (on) {
              this.service?.updateCharacteristic(
                  Characteristic.TargetHeatingCoolingState,
                  Characteristic.TargetHeatingCoolingState.COOL
              );
            }
          } finally {
            // 제어 결과와 무관하게 다단계 재조회(서버 반영 지연/실패 대응)
            setTimeout(() => this.refreshState().catch(() => {}), 150);
            setTimeout(() => this.refreshState().catch(() => {}), 450);
            setTimeout(() => this.refreshState().catch(() => {}), 1000);
          }
        }

        // HomeKit에서 목표 모드 조회 시 호출(OFF/COOL만 제공)
        async handleGetTargetHcState() {
          return this.cachedActive
              ? Characteristic.TargetHeatingCoolingState.COOL
              : Characteristic.TargetHeatingCoolingState.OFF;
        }

        // HomeKit에서 목표 모드 변경 시 호출
        async handleSetTargetHcState(value) {
          const v = Number(value);

          // OFF는 그대로 유지
          if (v === Characteristic.TargetHeatingCoolingState.OFF) {
            await this.handleSetActive(0);
            return;
          }

          // HEAT/COOL/AUTO 모두 COOL로 처리(난방/자동 미지원)
          await this.handleSetActive(1);

          // UI를 COOL로 강제
          this.service?.updateCharacteristic(
              Characteristic.TargetHeatingCoolingState,
              Characteristic.TargetHeatingCoolingState.COOL
          );
        }

        // HomeKit에서 현재 동작 상태 조회 시 호출
        async handleGetCurrentHcState() {
          return this.cachedActive
              ? Characteristic.CurrentHeatingCoolingState.COOL
              : Characteristic.CurrentHeatingCoolingState.OFF;
        }

        // 에어컨 상태를 강제로 재조회하여 캐시/표시 동기화
        async refreshState() {
          if (this.refreshPromise) return this.refreshPromise;

          this.refreshPromise = (async () => {
          try {
            const payload = await this.fetchAirConditioner();
            const a = this.extractAttrs(payload);
            if (!a) return;
            this.lastStateAt = Date.now();

            const ht = Number(a.HT);
            if (Number.isFinite(ht) && ht >= 18 && ht <= 30) {
              const pendingTarget =
                  this.pendingTargetTemp !== null &&
                  Date.now() < this.pendingTargetTempUntil &&
                  ht !== this.pendingTargetTemp;
              if (!pendingTarget) {
                this.cachedTargetTemp = ht;
                if (
                    this.pendingTargetTemp !== null &&
                    ht === this.pendingTargetTemp
                ) {
                  this.pendingTargetTemp = null;
                }
              }
            }

            const ct = Number(a.CT);
            if (Number.isFinite(ct) && ct > 0) this.cachedCurrentTemp = ct;

            if (a.POWER === "ON" || a.POWER === "OFF") {
              const serverActive = a.POWER === "ON";
              const pendingActive =
                  this.pendingActive !== null &&
                  Date.now() < this.pendingActiveUntil &&
                  serverActive !== this.pendingActive;
              if (!pendingActive) {
                this.cachedActive = serverActive;
                if (
                    this.pendingActive !== null &&
                    serverActive === this.pendingActive
                ) {
                  this.pendingActive = null;
                }
              }
            }

            this.service?.updateCharacteristic(
                Characteristic.TargetTemperature,
                this.cachedTargetTemp
            );
            this.service?.updateCharacteristic(
                Characteristic.CurrentTemperature,
                this.cachedCurrentTemp
            );
            this.service?.updateCharacteristic(
                Characteristic.Active,
                this.cachedActive ? 1 : 0
            );
            this.service?.updateCharacteristic(
                Characteristic.CurrentHeatingCoolingState,
                this.cachedActive
                    ? Characteristic.CurrentHeatingCoolingState.COOL
                    : Characteristic.CurrentHeatingCoolingState.OFF
            );
            this.service?.updateCharacteristic(
                Characteristic.TargetHeatingCoolingState,
                this.cachedActive
                    ? Characteristic.TargetHeatingCoolingState.COOL
                    : Characteristic.TargetHeatingCoolingState.OFF
            );
          } catch {
            // 폴링 실패는 무시(다음 주기에 재시도)
          }
          })();

          try {
            await this.refreshPromise;
          } finally {
            this.refreshPromise = null;
          }
        }
      }

  homebridge.registerAccessory(
      "homebridge-smartprugio",
      "SmartPrugioAirConditioner",
      SmartPrugioAirConditioner
  );
  // 하위 호환: 기존 이름도 계속 지원
  homebridge.registerAccessory(
      "homebridge-smartprugio",
      "SmartPrugioAircon",
      SmartPrugioAirConditioner
  );

  // -------------------------
  // 플랫폼: 다중 기기 일괄 등록(devices 배열)
  // -------------------------
  const ACCESSORY_CTORS = {
    SmartPrugioLight,
    SmartPrugioThermostat,
    SmartPrugioAirConditioner,
  };

  const ACCESSORY_ALIASES = {
    light: "SmartPrugioLight",
    lights: "SmartPrugioLight",
    thermostat: "SmartPrugioThermostat",
    heating: "SmartPrugioThermostat",
    smartprugiolight: "SmartPrugioLight",
    smartprugiothermostat: "SmartPrugioThermostat",
    smartprugioairconditioner: "SmartPrugioAirConditioner",
    smartprugioaircon: "SmartPrugioAirConditioner",
    airconditioner: "SmartPrugioAirConditioner",
    air_conditioner: "SmartPrugioAirConditioner",
    aircon: "SmartPrugioAirConditioner",
  };

  class SmartPrugioPlatform {
    constructor(log, config) {
      this.log = log;
      this.config = config || {};
      this.name = this.config.name || "SmartPrugio Platform";
    }

    accessories(callback) {
      const shared = {
        token: this.config.token,
        auth: this.config.auth,
        baseUrl: this.config.baseUrl,
        appVersion: this.config.appVersion,
        userAgent: this.config.userAgent,
        pollIntervalSec: this.config.pollIntervalSec,
        minControlIntervalMs: this.config.minControlIntervalMs,
        cacheMaxAgeMs: this.config.cacheMaxAgeMs,
        controlSyncWindowMs: this.config.controlSyncWindowMs,
      };

      const devices = Array.isArray(this.config.devices)
          ? this.config.devices
          : [];
      const out = [];

      for (const d of devices) {
        const rawType = String(
            d.accessory || d.type || d.deviceType || ""
        ).trim();
        const normalized = rawType.replace(/[^a-zA-Z_]/g, "").toLowerCase();
        const accessoryName = ACCESSORY_CTORS[rawType]
            ? rawType
            : ACCESSORY_ALIASES[normalized];

        if (!accessoryName || !ACCESSORY_CTORS[accessoryName]) {
          this.log(
              `[${this.name}] Unsupported device type: ${rawType || "(empty)"}. ` +
              `Use SmartPrugioLight | SmartPrugioThermostat | SmartPrugioAirConditioner`
          );
          continue;
        }
        if (!d.name || !d.deviceId) {
          this.log(
              `[${this.name}] Skip device: missing name/deviceId (${JSON.stringify(d)})`
          );
          continue;
        }

        const mergedConfig = {
          ...shared,
          ...d,
          accessory: accessoryName,
        };
        const Ctor = ACCESSORY_CTORS[accessoryName];
        out.push(new Ctor(this.log, mergedConfig));
      }

      this.log(`[${this.name}] Loaded ${out.length} SmartPrugio devices.`);
      callback(out);
    }
  }

  homebridge.registerPlatform(
      "homebridge-smartprugio",
      "SmartPrugioPlatform",
      SmartPrugioPlatform
  );
};
