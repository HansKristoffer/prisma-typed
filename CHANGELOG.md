# Changelog

## 0.1.0 (2026-11-07)


### Features

* brand id inputs, so another model's id is a type error ([8255c6e](https://github.com/HansKristoffer/prisma-typed/commit/8255c6e3eb1f2172245c1789eea67ebebb4ef0eb))
* check at compile time that each schema can type its column ([60929fb](https://github.com/HansKristoffer/prisma-typed/commit/60929fba5db64f7c2027693d8b3524c09e6d9fec))


### Bug Fixes

* never throw after a write has committed ([7740301](https://github.com/HansKristoffer/prisma-typed/commit/77403018ce4c2d521c668c01829aa25891a82dc7))
* refuse nested updates that leave `data` ambiguous ([6e8a06e](https://github.com/HansKristoffer/prisma-typed/commit/6e8a06edcf90e414699e8be09bb0e0757e315b40))
* refuse operations and nested writes it cannot check ([bafd0d2](https://github.com/HansKristoffer/prisma-typed/commit/bafd0d2df0cecab6a1fe04e4a102c9dadacc2478))
