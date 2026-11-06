let active = false;

/** While a cross-chain transfer runs, the wallet must stay on the source chain. */
export const bridging = {
  get: () => active,
  set: (value: boolean) => {
    active = value;
  },
};
