// Prints the ISO 4217 list known to this Node.js/ICU build, for refreshing packages/iso20022/src/currencies.ts.
console.log(JSON.stringify(Intl.supportedValuesOf('currency')));
