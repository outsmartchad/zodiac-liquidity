import { LightWasm } from "@lightprotocol/hasher.rs";

export const DEFAULT_ZERO = 0;

export class MerkleTree {
  levels: number;
  capacity: number;
  zeroElement;
  _zeros: string[];
  _layers: string[][];
  _lightWasm: LightWasm;

  constructor(
    levels: number,
    lightWasm: LightWasm,
    elements: string[] = [],
    { zeroElement = DEFAULT_ZERO } = {},
  ) {
    this.levels = levels;
    this.capacity = 2 ** levels;
    this.zeroElement = zeroElement.toString();
    this._lightWasm = lightWasm;
    if (elements.length > this.capacity) {
      throw new Error("Tree is full");
    }
    this._zeros = [];
    this._layers = [];
    this._layers[0] = elements;
    this._zeros[0] = this.zeroElement;

    for (let i = 1; i <= levels; i++) {
      this._zeros[i] = this._lightWasm.poseidonHashString([
        this._zeros[i - 1],
        this._zeros[i - 1],
      ]);
    }
    this._rebuild();
  }

  _rebuild() {
    for (let level = 1; level <= this.levels; level++) {
      this._layers[level] = [];
      for (let i = 0; i < Math.ceil(this._layers[level - 1].length / 2); i++) {
        this._layers[level][i] = this._lightWasm.poseidonHashString([
          this._layers[level - 1][i * 2],
          i * 2 + 1 < this._layers[level - 1].length
            ? this._layers[level - 1][i * 2 + 1]
            : this._zeros[level - 1],
        ]);
      }
    }
  }

  root() {
    return this._layers[this.levels].length > 0
      ? this._layers[this.levels][0]
      : this._zeros[this.levels];
  }

  insert(element: string) {
    if (this._layers[0].length >= this.capacity) {
      throw new Error("Tree is full");
    }
    this.update(this._layers[0].length, element);
  }

  bulkInsert(elements: string[]) {
    if (this._layers[0].length + elements.length > this.capacity) {
      throw new Error("Tree is full");
    }
    this._layers[0].push(...elements);
    this._rebuild();
  }

  update(index: number, element: string) {
    if (
      isNaN(Number(index)) ||
      index < 0 ||
      index > this._layers[0].length ||
      index >= this.capacity
    ) {
      throw new Error("Insert index out of bounds: " + index);
    }
    this._layers[0][index] = element;
    for (let level = 1; level <= this.levels; level++) {
      index >>= 1;
      this._layers[level][index] = this._lightWasm.poseidonHashString([
        this._layers[level - 1][index * 2],
        index * 2 + 1 < this._layers[level - 1].length
          ? this._layers[level - 1][index * 2 + 1]
          : this._zeros[level - 1],
      ]);
    }
  }

  path(index: number) {
    if (isNaN(Number(index)) || index < 0 || index >= this._layers[0].length) {
      throw new Error("Index out of bounds: " + index);
    }
    const pathElements: string[] = [];
    const pathIndices: number[] = [];
    for (let level = 0; level < this.levels; level++) {
      pathIndices[level] = index % 2;
      pathElements[level] =
        (index ^ 1) < this._layers[level].length
          ? this._layers[level][index ^ 1]
          : this._zeros[level];
      index >>= 1;
    }
    return {
      pathElements,
      pathIndices,
    };
  }

  indexOf(element: string, comparator: Function | null = null) {
    if (comparator) {
      return this._layers[0].findIndex((el: string) => comparator(element, el));
    } else {
      return this._layers[0].indexOf(element);
    }
  }

  elements() {
    return this._layers[0].slice();
  }

  serialize() {
    return {
      levels: this.levels,
      _zeros: this._zeros,
      _layers: this._layers,
    };
  }

  static deserialize(data: any, hashFunction: Function) {
    const instance = Object.assign(Object.create(this.prototype), data);
    instance._hash = hashFunction;
    instance.capacity = 2 ** instance.levels;
    instance.zeroElement = instance._zeros[0];
    return instance;
  }
}
