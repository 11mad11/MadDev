import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { dirname, join } from "path"
import * as v from 'valibot';

export class Settings {

    constructor(
        public readonly baseDir: string = "./config"
    ) {

    }

    getRaw(name: string): string | undefined;
    getRaw(name: string, def: () => string): string;
    getRaw(name: string, def?: () => string) {
        const path = join(this.baseDir, name);
        if (!existsSync(path)) {
            mkdirSync(dirname(path), { recursive: true });
            const result = def?.();
            if (result)
                writeFileSync(path, result);
            return result;
        }

        return readFileSync(path)
    }

    setRaw(name: string, value: string) {
        const path = join(this.baseDir, name);
        writeFileSync(path, value);
    }

    getJSON<S extends v.GenericSchema>(name: string, schema: S): v.InferOutput<S> | undefined;
    getJSON<S extends v.GenericSchema>(name: string, schema: S, def: () => v.InferOutput<S>): v.InferOutput<S>
    getJSON<S extends v.GenericSchema>(name: string, schema: S, def?: () => v.InferOutput<S>): v.InferOutput<S> | undefined {
        const raw = this.getRaw(name)?.toString();
        if (!raw) {
            const result = def?.();
            if (result)
                this.setJSON(name, result);
            return result;
        }
        return v.parse(schema, JSON.parse(raw));
    }

    setJSON(name: string, value: any) {
        this.setRaw(name, JSON.stringify(value, undefined, 2));
    }

    load<S extends v.GenericSchema>(name: string, schema: S, def: () => v.InferOutput<S>) {
        const mapSave = new Map();
        const mapLoad = new Map();
        const setting = this;
        const ctx = {
            data: this.getJSON(name, schema, def),
            onSave(cb: () => void) {
                mapSave.set(cb, true);
            },
            onReload(cb: () => void) {
                mapLoad.set(cb, true);
            },
            save() {
                mapSave.forEach(([k, _]) => k());
                setting.setJSON(name, ctx.data);
            },
            reload() {
                ctx.data = this.getJSON(name, schema, def);
                mapLoad.forEach(([k, _]) => k());
            }
        }
        return ctx;
    }

}