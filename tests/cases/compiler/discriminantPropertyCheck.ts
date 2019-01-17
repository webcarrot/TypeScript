// @strictNullChecks: true

type Item = Item1 | Item2;

interface Base {
    bar: boolean;
}

interface Item1 extends Base {
    kind: "A";
    foo: string | undefined;
    baz: boolean;
    qux: true;
}

interface Item2 extends Base {
    kind: "B";
    foo: string | undefined;
    baz: boolean;
    qux: false;
}

function goo1(x: Item) {
    if (x.kind === "A" && x.foo !== undefined) {
        x.foo.length;
    }
}

function goo2(x: Item) {
    if (x.foo !== undefined && x.kind === "A") {
        x.foo.length;  // Error, intervening discriminant guard
    }
}

function foo1(x: Item) {
    if (x.bar && x.foo !== undefined) {
        x.foo.length;
    }
}

function foo2(x: Item) {
    if (x.foo !== undefined && x.bar) {
        x.foo.length;
    }
}

function foo3(x: Item) {
    if (x.baz && x.foo !== undefined) {
        x.foo.length;
    }
}

function foo4(x: Item) {
    if (x.foo !== undefined && x.baz) {
        x.foo.length;
    }
}

function foo5(x: Item) {
    if (x.qux && x.foo !== undefined) {
        x.foo.length;
    }
}

function foo6(x: Item) {
    if (x.foo !== undefined && x.qux) {
        x.foo.length;  // Error, intervening discriminant guard
    }
}

// Repro from #27493

enum Types { Str = 1, Num = 2 }

type Instance = StrType | NumType;

interface StrType {
    type: Types.Str;
    value: string;
    length: number;
}

interface NumType {
    type: Types.Num;
    value: number;
}

function func2(inst: Instance) {
    while (true) {
        switch (inst.type) {
            case Types.Str: {
                inst.value.length;
                break;
            }
            case Types.Num: {
                inst.value.toExponential;
                break;
            }
        }
    }
}

// Repro from #29106

const f = (_a: string, _b: string): void => {};

interface A {
  a?: string;
  b?: string;
}

interface B {
  a: string;
  b: string;
}

type U = A | B;

const u: U = {} as any;

u.a && u.b && f(u.a, u.b);

u.b && u.a && f(u.a, u.b);
