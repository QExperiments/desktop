# Agent notes

Project conventions for humans and coding agents. Keep this file short: one heading per concern, no duplicated essays.

## JavaScript

Prefer `const` arrow functions over `function` declarations in new and edited `.js` files.

```javascript
export const waitForPeer = async (providerPublicKey, logger = console) => {}
```

Do not change object methods or class constructors. One-liners may omit braces and `return`.
