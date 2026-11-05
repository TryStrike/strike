/**
 * Jest stub for @privy-io/react-auth (ships ESM that jest will not parse).
 */
const noop = () => {};
const hook = () => ({});

module.exports = new Proxy(
  {
    __esModule: true,
    usePrivy: () => ({ ready: true, authenticated: false, user: null, login: noop, logout: noop }),
    useWallets: () => ({ wallets: [] }),
  },
  {
    get(target, prop) {
      if (prop in target) return target[prop];
      // Anything else resolves to an inert function so unexpected named
      // imports do not blow up at import time.
      return hook;
    },
  }
);
