import chalk from "chalk";

export function prettyTerm(output: NodeJS.WritableStream){

    return {
        h1(txt: string) {
            output.write("\n" + chalk.bgWhite.underline.black(txt) + "\n");
        },
        h3(txt: string) {
            output.write(chalk.underline.italic(txt) + "\n");
        },
        h2(txt: string) {
            output.write("\n" + chalk.underline.bold(txt) + "\n");
        },
        line(txt: string = "", newline = true) {
            output.write(txt + (newline ? "\n" : " "));
        },
        cmd(txt: string, newline = true) {
            output.write(chalk.yellow(txt) + (newline ? "\n" : " "));
        }
    }
}