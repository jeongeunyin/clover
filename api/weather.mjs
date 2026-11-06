// KMA's public-data service key stays on the server. Set KMA_SERVICE_KEY in Vercel.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const cityGroups = require('../weather-cities.js');

// KMA's 5 km Lambert conformal conic grid projection.
function toGrid(lat, lon) {
  const rad = Math.PI / 180;
  const re = 6371.00877 / 5;
  const slat1 = 30 * rad, slat2 = 60 * rad, olon = 126 * rad, olat = 38 * rad;
  const sn = Math.log(Math.cos(slat1) / Math.cos(slat2)) /
    Math.log(Math.tan(Math.PI / 4 + slat2 / 2) / Math.tan(Math.PI / 4 + slat1 / 2));
  const sf = Math.tan(Math.PI / 4 + slat1 / 2) ** sn * Math.cos(slat1) / sn;
  const ro = re * sf / Math.tan(Math.PI / 4 + olat / 2) ** sn;
  const ra = re * sf / Math.tan(Math.PI / 4 + lat * rad / 2) ** sn;
  const theta = (lon * rad - olon) * sn;
  return { nx: Math.floor(ra * Math.sin(theta) + 43 + 0.5),
    ny: Math.floor(ro - ra * Math.cos(theta) + 136 + 0.5) };
}
const CITIES = Object.fromEntries(cityGroups.flatMap(({ region, cities }) =>
  cities.map(([id, name, lat, lon]) => [id, { name: `${region === '특별시·광역시·특별자치시' ? '' : region + ' '}${name}`, lat, lon, ...toGrid(lat, lon) }])));

const API_URL = 'https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/getVilageFcst';
const KST_OFFSET = 9 * 60 * 60 * 1000;
const pad = (value) => String(value).padStart(2, '0');
const dateCode = (date) => `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`;
const finiteNumber = (value) => value === undefined || value === null || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;

function forecastBaseTime(now = new Date()) {
  // KMA issues these forecasts at 02/05/08/11/14/17/20/23 KST.
  // Leave 20 minutes for the latest cycle to reach the public-data API.
  const base = new Date(now.getTime() + KST_OFFSET - 20 * 60 * 1000);
  const cycle = [23, 20, 17, 14, 11, 8, 5, 2].find((hour) => hour <= base.getUTCHours());
  if (cycle === undefined) {
    base.setUTCDate(base.getUTCDate() - 1);
    base.setUTCHours(23, 0, 0, 0);
  } else {
    base.setUTCHours(cycle, 0, 0, 0);
  }
  return base;
}

async function getForecast(base, city, key) {
  const url = new URL(API_URL);
  url.searchParams.set('serviceKey', key);
  url.searchParams.set('pageNo', '1');
  url.searchParams.set('numOfRows', '1000');
  url.searchParams.set('dataType', 'JSON');
  url.searchParams.set('base_date', dateCode(base));
  url.searchParams.set('base_time', `${pad(base.getUTCHours())}00`);
  url.searchParams.set('nx', String(city.nx));
  url.searchParams.set('ny', String(city.ny));

  const upstream = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!upstream.ok) throw new Error('KMA_HTTP_ERROR');
  const payload = await upstream.json();
  if (payload?.response?.header?.resultCode !== '00') throw new Error('KMA_API_ERROR');
  const items = payload?.response?.body?.items?.item;
  if (!Array.isArray(items) || !items.length) throw new Error('KMA_NO_DATA');
  return items;
}

function summarize(items, city, base) {
  const nowKst = new Date(Date.now() + KST_OFFSET);
  const today = dateCode(nowKst);
  const currentTime = `${pad(nowKst.getUTCHours())}${pad(nowKst.getUTCMinutes())}`;
  const todayItems = items.filter((item) => item.fcstDate === today);
  const hours = [...new Set(todayItems.filter((item) => item.category === 'TMP').map((item) => item.fcstTime))].sort();
  if (!hours.length) throw new Error('KMA_NO_TODAY');
  const hour = hours.find((time) => time >= currentTime) || hours[hours.length - 1];
  const atTime = (category) => todayItems.find((item) => item.category === category && item.fcstTime === hour)?.fcstValue;
  const onDay = (category) => todayItems.find((item) => item.category === category)?.fcstValue;
  const precipitationType = Number(atTime('PTY') || 0);
  const skyCode = Number(atTime('SKY') || 0);
  const condition = precipitationType === 3 || precipitationType === 7 ? '눈' :
    precipitationType === 2 || precipitationType === 6 ? '비 또는 눈' :
    precipitationType > 0 ? '비' :
    skyCode === 1 ? '맑음' : skyCode === 3 ? '구름많음' : '흐림';
  return {
    source: '기상청 단기예보', city: city.name, forecastDate: today,
    forecastTime: hour, issuedAt: `${dateCode(base)} ${pad(base.getUTCHours())}:00 KST`,
    condition, temperature: finiteNumber(atTime('TMP')),
    minimum: finiteNumber(onDay('TMN')), maximum: finiteNumber(onDay('TMX')),
    precipitationProbability: finiteNumber(atTime('POP')),
    windSpeed: finiteNumber(atTime('WSD')),
  };
}

function openMeteoCondition(code) {
  if ([71, 73, 75, 77, 85, 86].includes(code)) return '눈';
  if ([66, 67].includes(code)) return '비 또는 눈';
  if ([51, 53, 55, 56, 57, 61, 63, 65, 80, 81, 82, 95, 96, 99].includes(code)) return '비';
  if (code === 0) return '맑음';
  if ([1, 2].includes(code)) return '구름많음';
  return '흐림';
}

async function getOpenMeteo(city) {
  const url = new URL(process.env.OPEN_METEO_API_KEY
    ? 'https://customer-api.open-meteo.com/v1/forecast'
    : 'https://api.open-meteo.com/v1/forecast');
  url.searchParams.set('latitude', String(city.lat));
  url.searchParams.set('longitude', String(city.lon));
  url.searchParams.set('current', 'temperature_2m,weather_code,wind_speed_10m');
  url.searchParams.set('daily', 'temperature_2m_min,temperature_2m_max,precipitation_probability_max');
  url.searchParams.set('timezone', 'Asia/Seoul');
  url.searchParams.set('wind_speed_unit', 'ms');
  url.searchParams.set('forecast_days', '1');
  if (process.env.OPEN_METEO_API_KEY) url.searchParams.set('apikey', process.env.OPEN_METEO_API_KEY);
  const upstream = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!upstream.ok) throw new Error('OPEN_METEO_HTTP_ERROR');
  const payload = await upstream.json();
  const current = payload.current, daily = payload.daily;
  if (!current || !daily?.time?.[0] || finiteNumber(current.temperature_2m) === null) throw new Error('OPEN_METEO_NO_DATA');
  return {
    source: 'Open-Meteo', city: city.name, forecastDate: daily.time[0].replaceAll('-', ''),
    forecastTime: current.time?.slice(11, 16).replace(':', '') || '0000',
    issuedAt: current.time, condition: openMeteoCondition(Number(current.weather_code)),
    temperature: finiteNumber(current.temperature_2m),
    minimum: finiteNumber(daily.temperature_2m_min?.[0]),
    maximum: finiteNumber(daily.temperature_2m_max?.[0]),
    precipitationProbability: finiteNumber(daily.precipitation_probability_max?.[0]),
    windSpeed: finiteNumber(current.wind_speed_10m),
  };
}

export function GET(request) {
  return handle(request);
}

async function handle(request) {
  const cityId = new URL(request.url).searchParams.get('city') || 'seoul';
  const city = CITIES[cityId];
  if (!city) return Response.json({ error: '지원하지 않는 지역이에요.' }, { status: 400 });
  const key = process.env.KMA_SERVICE_KEY;
  if (key) {
    const base = forecastBaseTime();
    for (const candidate of [base, new Date(base.getTime() - 3 * 60 * 60 * 1000)]) {
      try {
        const items = await getForecast(candidate, city, key);
        const weather = summarize(items, city, candidate);
        return Response.json(weather, { headers: { 'Cache-Control': 's-maxage=1800, stale-while-revalidate=600' } });
      } catch (error) {
        // Continue with the previous cycle, then the public fallback source.
      }
    }
  }
  try {
    const weather = await getOpenMeteo(city);
    return Response.json(weather, { headers: { 'Cache-Control': 's-maxage=900, stale-while-revalidate=300' } });
  } catch (error) {
    return Response.json({ error: '날씨를 지금 불러올 수 없어요.' }, { status: 502 });
  }
}
