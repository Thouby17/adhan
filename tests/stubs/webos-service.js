// Faux module `webos-service` pour les tests.
//
// Il permet de charger le VRAI src/service/adhan_service.js hors de la TV et
// de capturer ce qu'il aurait demandé au système. On teste ainsi le fichier
// réellement livré, pas une copie de sa logique.

module.exports = function Service(name) {
  this.name = name;
  this.handlers = {};
  this.register = function (method, fn) { this.handlers[method] = fn; };
  this.call = function (uri, params, cb) {
    (global.__ADHAN_LAUNCHES = global.__ADHAN_LAUNCHES || []).push({
      at: new Date(),
      uri: uri,
      prayer: params && params.params && params.params.prayer
    });
    if (cb) cb({ payload: { returnValue: true } });
  };
};
