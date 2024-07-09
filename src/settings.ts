import { existsSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"
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

}