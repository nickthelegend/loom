/** Background registration must not replace the active computer's account status. */
export function pushRegistration<C, S>(register: (creds: C) => Promise<S>) {
  let state: S | null = null;
  return {
    last: () => state,
    background: (creds: C) => register(creds),
    async active(creds: C) { state = await register(creds); return state; },
  };
}
export function backgroundMachines<M extends { id: string }>(machines: M[], activeId: string | null) {
  return machines.filter(m => m.id !== activeId);
}
