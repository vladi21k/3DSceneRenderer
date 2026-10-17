// Tiny event bus for cross-system signals.
//   'bell'            {auto:boolean}           tram bell rang (audio plays it, crowd reacts)
//   'bell-request'    {urgency:0..1}           crowd asks for the bell (pedestrian near track ahead)
//   'station-arrive'  {station}                tram stopped at a platform
//   'station-depart'  {station}
//   'doors'           {open:boolean}
//   'tod'             {t}                      time of day changed
//   'start'           {}                       user clicked to start (audio may begin)
//   'tram-bell'       {unit, s, d}             an oncoming tram rang its bell
//   'ready'           {}                       initial world built
export class Events {
  constructor() { this.map = new Map(); }
  on(type, fn) { if (!this.map.has(type)) this.map.set(type, new Set()); this.map.get(type).add(fn); return () => this.map.get(type).delete(fn); }
  emit(type, data) { const s = this.map.get(type); if (s) for (const fn of s) { try { fn(data); } catch (e) { console.error(e); } } }
}
