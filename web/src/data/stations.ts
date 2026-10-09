// Curated for the public demo: all confirmed `audio/mpeg` (so the capture
// endpoint can forward raw bytes straight to OpenRouter -- no transcoding).
// A separate, larger list (including non-mp3 stations) lives in the CLI
// project's streams.json; kept independent on purpose, since this list
// needs to be small and reliably direct-compatible for strangers on the
// internet, not just for one person experimenting locally.
export interface Station {
  id: string;
  name: string;
  url: string;
  weight: number;
}

export const STATIONS: Station[] = [
  { id: 'bbc', name: 'BBC World Service', url: 'https://stream.live.vc.bbcmedia.co.uk/bbc_world_service', weight: 4 },
  { id: 'paranormalium', name: 'Paranormalium', url: 'http://shoutcast.paranormalium.pl:8000/1', weight: 5 },
  { id: 'cspan', name: 'C-SPAN Radio', url: 'https://26183.live.streamtheworld.com:443/CSPANRADIO.mp3', weight: 3 },
  { id: 'kpfa', name: 'KPFA', url: 'https://streams.kpfa.org/kpfa_64', weight: 3 },
  // Non-English talk/news -- the translation effect reads as more
  // interesting than the English-only fragments, so these are weighted
  // on par with Paranormalium.
  { id: 'bbc_arabic', name: 'BBC Arabic', url: 'https://stream.live.vc.bbcmedia.co.uk/bbc_arabic_radio', weight: 4 },
  {
    id: 'cadena_ser',
    name: 'Cadena SER',
    url: 'https://playerservices.streamtheworld.com/api/livestream-redirect/CADENASER.mp3',
    weight: 4
  },
  { id: 'france_info', name: 'France Info', url: 'https://icecast.radiofrance.fr/franceinfo-midfi.mp3', weight: 4 },
  { id: 'deutschlandfunk', name: 'Deutschlandfunk', url: 'https://st01.sslstream.dlf.de/dlf/01/mp3/128/stream.mp3', weight: 4 },
  { id: 'radio_radicale', name: 'Radio Radicale', url: 'https://live.radioradicale.it/live.mp3', weight: 4 }
];

export function pickWeighted(stations: Station[] = STATIONS): Station {
  const total = stations.reduce((sum, s) => sum + s.weight, 0);
  let r = Math.random() * total;
  for (const s of stations) {
    if (r < s.weight) return s;
    r -= s.weight;
  }
  return stations[stations.length - 1];
}
