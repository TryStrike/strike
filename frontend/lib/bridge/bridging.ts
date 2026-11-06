let active = false;

export const bridging = {
  get: () => active,
  set: (value: boolean) => {
    active = value;
  },
};
