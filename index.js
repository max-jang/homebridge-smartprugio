// index.js (homebridge-smartprugio)
// 전등(LIGHTS) + 보일러(HEATING) 액세서리를 한 파일에 통합
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
  homebridge.registerAccessory(
      "homebridge-smartprugio",
      "SmartPrugioLight",
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
          this.debouncer = new Debouncer(config.minControlIntervalMs ?? 600);

          // 주기적 폴링(0이면 비활성화)
          this.pollIntervalSec = config.pollIntervalSec ?? 10;
          if (this.pollIntervalSec > 0) {
            setInterval(
                () => this.refreshState().catch(() => {}),
                this.pollIntervalSec * 1000
            );
          }

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
          try {
            const payload = await this.fetchLights();
            const v = this.extractPower(payload);

            if (v === "ON") this.cachedOn = true;
            else if (v === "OFF") this.cachedOn = false;

            // 핵심: GET 성공 시 HomeKit 표시를 즉시 갱신
            this.service?.updateCharacteristic(Characteristic.On, this.cachedOn);

            return this.cachedOn;
          } catch (e) {
            this.log(`LIGHTS GET 실패: ${e?.message || e}`);
            return this.cachedOn;
          }
        }

        // HomeKit에서 전등 상태 변경 시 호출
        async handleSetOn(value) {
          if (!this.debouncer.allow()) {
            // 요청 간격이 너무 짧으면 캐시만 반영하고 종료
            this.cachedOn = !!value;
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
              { device_attr_cd: "POWER", set_cont: value ? "ON" : "OFF" },
            ],
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

          this.log(`LIGHTS 제어 접수: ${JSON.stringify(res.data)}`);
          this.cachedOn = !!value;

          // 제어 후 짧은 지연 뒤 실제 상태 재조회
          setTimeout(() => this.refreshState().catch(() => {}), 800);
        }

        // 전등 상태를 강제로 재조회하여 캐시/표시 동기화
        async refreshState() {
          try {
            const payload = await this.fetchLights();
            const v = this.extractPower(payload);
            this.log(`LIGHTS status ${this.deviceId}: ${v}`);

            if (v === "ON") this.cachedOn = true;
            else if (v === "OFF") this.cachedOn = false;

            this.service?.updateCharacteristic(Characteristic.On, this.cachedOn);
          } catch {
            // 폴링 실패는 무시(다음 주기에 재시도)
          }
        }
      }
  );

  // -------------------------
  // 액세서리: 보일러(난방)
  // - 모드 제어 없음
  // - POWER + HTEMPERATURE만 사용
  // - Cool/Auto는 HEAT로 강제
  // -------------------------
  homebridge.registerAccessory(
      "homebridge-smartprugio",
      "SmartPrugioThermostat",
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

          // 주기적 폴링(0이면 비활성화)
          this.pollIntervalSec = config.pollIntervalSec ?? 10;
          if (this.pollIntervalSec > 0) {
            setInterval(
                () => this.refreshState().catch(() => {}),
                this.pollIntervalSec * 1000
            );
          }

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
          try {
            const payload = await this.fetchHeating();
            const a = this.extractAttrs(payload);
            if (!a) return this.cachedCurrentTemp;

            const ct = Number(a.CT);
            // 0 또는 비정상 값이면 캐시 유지
            if (Number.isFinite(ct) && ct > 0) this.cachedCurrentTemp = ct;

            return this.cachedCurrentTemp;
          } catch (e) {
            this.log(`HEATING 현재온도 GET 실패: ${e?.message || e}`);
            return this.cachedCurrentTemp;
          }
        }

        // HomeKit에서 목표 온도 조회 시 호출
        async handleGetTargetTemp() {
          try {
            const payload = await this.fetchHeating();
            const a = this.extractAttrs(payload);
            if (!a) return this.cachedTargetTemp;

            const ht = Number(a.HT);
            if (Number.isFinite(ht) && ht >= 5 && ht <= 40)
              this.cachedTargetTemp = ht;

            return this.cachedTargetTemp;
          } catch (e) {
            this.log(`HEATING 목표온도 GET 실패: ${e?.message || e}`);
            return this.cachedTargetTemp;
          }
        }

        // HomeKit에서 목표 온도 변경 시 호출
        async handleSetTargetTemp(value) {
          const v = Math.round(Number(value));
          if (!Number.isFinite(v)) return;

          this.cachedTargetTemp = v;
          this.cachedActive = true;

          if (!this.debouncer.allow()) return;

          // 한 번의 요청으로 POWER=ON + HTEMPERATURE 설정
          await this.controlMany([
            ["POWER", "ON"],
            ["HTEMPERATURE", v],
          ]);

          // 제어 후 짧은 지연 뒤 실제 상태 재조회
          setTimeout(() => this.refreshState().catch(() => {}), 800);
        }

        // HomeKit에서 난방 ON/OFF 조회 시 호출
        async handleGetActive() {
          try {
            const payload = await this.fetchHeating();
            const a = this.extractAttrs(payload);
            if (!a) return this.cachedActive ? 1 : 0;

            if (a.POWER === "ON") this.cachedActive = true;
            else if (a.POWER === "OFF") this.cachedActive = false;

            return this.cachedActive ? 1 : 0;
          } catch (e) {
            this.log(`HEATING Active GET 실패: ${e?.message || e}`);
            return this.cachedActive ? 1 : 0;
          }
        }

        // HomeKit에서 난방 ON/OFF 변경 시 호출
        async handleSetActive(value) {
          const on = Number(value) === 1;
          this.cachedActive = on;

          if (!this.debouncer.allow()) return;

          // POWER만 제어
          await this.controlMany([["POWER", on ? "ON" : "OFF"]]);

          // 켜질 때 UI 상태를 HEAT로 즉시 강제
          if (on) {
            this.service?.updateCharacteristic(
                Characteristic.TargetHeatingCoolingState,
                Characteristic.TargetHeatingCoolingState.HEAT
            );
          }

          // 제어 후 짧은 지연 뒤 실제 상태 재조회
          setTimeout(() => this.refreshState().catch(() => {}), 800);
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
          try {
            const payload = await this.fetchHeating();
            const a = this.extractAttrs(payload);
            if (!a) return;

            const ht = Number(a.HT);
            if (Number.isFinite(ht) && ht >= 5 && ht <= 40)
              this.cachedTargetTemp = ht;

            const ct = Number(a.CT);
            if (Number.isFinite(ct) && ct > 0) this.cachedCurrentTemp = ct;

            if (a.POWER === "ON") this.cachedActive = true;
            else if (a.POWER === "OFF") this.cachedActive = false;

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
        }
      }
  );
};
