// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
'use strict';
import { Kernel, ServerConnection, SessionManager } from '@jupyterlab/services';
import { inject, injectable } from 'inversify';
import { Disposable } from 'vscode-jsonrpc';
import fs from 'fs';

import { IFileSystem } from '../common/platform/types';
import {
    ExecutionResult,
    IProcessService,
    IProcessServiceFactory,
    IPythonExecutionFactory,
    ObservableExecutionResult,
    SpawnOptions
} from '../common/process/types';
import { IDisposableRegistry, ILogger } from '../common/types';
import { IS_WINDOWS } from '../common/util';
import * as localize from '../common/utils/localize';
import {
    ICondaService,
    IInterpreterService,
    IKnownSearchPathsForInterpreters,
    InterpreterType,
    PythonInterpreter
} from '../interpreter/contracts';
import { IServiceContainer } from '../ioc/types';
import { JupyterConnection } from './jupyterConnection';
import { IConnection, IJupyterExecution, IJupyterKernelSpec, INotebookServer } from './types';
import { fsReaddirAsync } from '../common/utils/fs';

const CheckJupyterRegEx = IS_WINDOWS ? /^jupyter?\.exe$/ : /^jupyter?$/;


class JupyterKernelSpec implements IJupyterKernelSpec {
    public name: string;
    public language: string;
    public path: string;
    public specFile: string | undefined;
    constructor(specModel : Kernel.ISpecModel, file?: string) {
        this.name = specModel.name;
        this.language = specModel.language;
        this.path = specModel.argv.length > 0 ? specModel.argv[0] : '';
        this.specFile = file;
    }
}

// JupyterCommand objects represent some process that can be launched that should be guaranteed to work because it
// was found by testing it previously
class JupyterCommand {
    public mainVersion: number;
    private exe: string;
    private requiredArgs: string[];
    private launcher: IProcessService;
    private interpreter: IInterpreterService;
    private condaService: ICondaService;

    constructor(exe: string, args: string[], launcher: IProcessService, interpreter: IInterpreterService, condaService: ICondaService) {
        this.exe = exe;
        this.requiredArgs = args;
        this.launcher = launcher;
        this.interpreter = interpreter;
        this.condaService = condaService;
        this.interpreter.getInterpreterDetails(this.exe).then(i => this.mainVersion = i.version_info[0]).catch(e => this.mainVersion = 0);
    }

    public execObservable = async (args: string[], options: SpawnOptions): Promise<ObservableExecutionResult<string>> => {
        const newOptions = {...options};
        newOptions.env = await this.fixupCondaEnv(newOptions.env);
        const newArgs = [...this.requiredArgs, ...args];
        return this.launcher.execObservable(this.exe, newArgs, newOptions);
    }

    public exec = async (args: string[], options: SpawnOptions): Promise<ExecutionResult<string>> => {
        const newOptions = {...options};
        newOptions.env = await this.fixupCondaEnv(newOptions.env);
        const newArgs = [...this.requiredArgs, ...args];
        return this.launcher.exec(this.exe, newArgs, newOptions);
    }

    /**
     * Conda needs specific paths and env vars set to be happy. Call this function to fix up
     * (or created if not present) our environment to run jupyter
     */
    // Base Node.js SpawnOptions uses any for environment, so use that here as well
    // tslint:disable-next-line:no-any
    private fixupCondaEnv = async (inputEnv: any | undefined): Promise<any> => {
        if (!inputEnv) {
            inputEnv = process.env;
        }
        const interpreter = await this.interpreter.getActiveInterpreter();
        if (interpreter && interpreter.type === InterpreterType.Conda) {
            return this.condaService.getActivatedCondaEnvironment(interpreter, inputEnv);
        }

        return inputEnv;
    }

}

@injectable()
export class JupyterExecution implements IJupyterExecution, Disposable {

    private processServicePromise: Promise<IProcessService>;
    private commands : {[command: string] : JupyterCommand } = {};
    private jupyterPath : string | undefined;
    private createdSpecs : string[] = [];

    constructor(@inject(IPythonExecutionFactory) private executionFactory: IPythonExecutionFactory,
                @inject(ICondaService) private condaService: ICondaService,
                @inject(IInterpreterService) private interpreterService: IInterpreterService,
                @inject(IProcessServiceFactory) private processServiceFactory: IProcessServiceFactory,
                @inject(IKnownSearchPathsForInterpreters) private knownSearchPaths: IKnownSearchPathsForInterpreters,
                @inject(ILogger) private logger: ILogger,
                @inject(IDisposableRegistry) private disposableRegistry: IDisposableRegistry,
                @inject(IFileSystem) private fileSystem: IFileSystem,
                @inject(IServiceContainer) private serviceContainer: IServiceContainer) {
        this.processServicePromise = this.processServiceFactory.create();
        this.disposableRegistry.push(this);
    }

    public dispose() {
        // Don't do this async as we may not be listened to.

        // Delete all created specs
        this.createdSpecs.forEach(c => this.deleteSpec(c));
        this.createdSpecs = [];
    }

    public isNotebookSupported = (): Promise<boolean> => {
        // See if we can find the command notebook
        return this.isCommandSupported('notebook');
    }

    public isImportSupported = async (): Promise<boolean> => {
        // See if we can find the command nbconvert
        return this.isCommandSupported('nbconvert');
    }

    public isipykernelSupported = async (): Promise<boolean> => {
        // See if we can find the command ipykernel
        return this.isCommandSupported('ipykernel');
    }

    public isKernelSpecSupported = async (): Promise<boolean> => {
        // See if we can find the command kernelspec
        return this.isCommandSupported('kernelspec');
    }

    public startNotebookServer = async () : Promise<INotebookServer> => {
        // First we find a way to start a notebook server
        const notebookCommand = await this.findBestCommand('notebook');
        if (!notebookCommand) {
            throw new Error(localize.DataScience.jupyterNotSupported());
        }

        // Now actually launch it
        try {
            const path = await import('path');

            // First generate a temporary notebook. We need this as input to the session
            const tempFile = await this.generateTempFile();

            // Use this temp file to generate a list of args for our command
            const args: string [] = ['--no-browser', `--notebook-dir=${path.dirname(tempFile)}`];

            // Before starting the notebook process, make sure we generate a kernel spec
            let kernelSpec = await this.getMatchingKernelSpec();

            // Then use this to launch our notebook process.
            const launchResult = await notebookCommand.execObservable(args, { throwOnStdErr: false, encoding: 'utf8'});

            // Wait for the connection information on this result
            const connection = await JupyterConnection.waitForConnection(launchResult, notebookCommand.mainVersion, this.logger);

            // If the kernel spec didn't match, then try with our current process instead
            if (!kernelSpec) {
                kernelSpec = await this.getMatchingKernelSpec(connection);
            }

            // Then use this to connect to the jupyter process
            const result = this.serviceContainer.get<INotebookServer>(INotebookServer);
            this.disposableRegistry.push(result);
            await result.connect(connection, kernelSpec);
            return result;

        } catch (err) {
            // Something else went wrong
            throw new Error(localize.DataScience.jupyterNotebookFailure().format(err));
        }
    }

    public spawnNotebook = async (file: string) : Promise<void> => {
        // First we find a way to start a notebook server
        const notebookCommand = await this.findBestCommand('notebook');
        if (!notebookCommand) {
            throw new Error(localize.DataScience.jupyterNotSupported());
        }

        const args: string [] = [`--NotebookApp.file_to_run=${file}`];

        // Don't wait for the exec to finish and don't dispose. It's up to the user to kill the process
        notebookCommand.exec(args, {throwOnStdErr: false, encoding: 'utf8'});
    }

    public importNotebook = async (file: string, template: string) : Promise<string> => {
        // First we find a way to start a nbconvert
        const convert = await this.findBestCommand('nbconvert');
        if (!convert) {
            throw new Error(localize.DataScience.jupyterNbConvertNotSupported());
        }

        const args: string [] = [`--NotebookApp.file_to_run=${file}`];

        // Wait for the nbconvert to finish
        const result = await convert.exec([file, '--to', 'python', '--stdout', '--template', template], { throwOnStdErr: true, encoding: 'utf8' });
        return result.stdout;
    }

    private deleteSpec(specFile: string) {
        // This needs to be synchronous as it happens on shutdown
        fs.unlinkSync(specFile);
    }

    private async getMatchingKernelSpec(connection?: IConnection) : Promise<IJupyterKernelSpec | undefined> {

        // If not using an active connection, check on disk
        if (!connection) {
            // Enumerate our kernel specs that jupyter will know about and see if
            // one of them already matches based on path
            if (!await this.hasSpecPathMatch()) {
                // Nobody matches on path, so generate a new kernel spec
                if (await this.isipykernelSupported()) {
                    const displayName = localize.DataScience.historyTitle();
                    const ipykernelCommand = await this.findBestCommand('ipykernel');
                    try {
                        const uuid = await import('uuid/v4');
                        const name = uuid.default();

                        // If this fails, then we just skip this spec
                        await ipykernelCommand.exec(['install', '--user', '--name', name, '--display-name', `'${displayName}'`], { throwOnStdErr: true, encoding: 'utf8' });

                        // If it doesn't fail, then this is a spec we need to destroy later. Find its on disk path
                        const diskPath = await this.findSpecPath(name);
                        if (diskPath) {
                            this.createdSpecs.push(diskPath);
                        }

                    } catch (err) {
                        this.logger.logError(err);
                    }
                }
            }
        }

        // Now enumerate them again
        const enumerator = connection ? () => this.getActiveKernelSpecs(connection) : this.enumerateSpecs;

        // Then find our match
        return this.findSpecMatch(enumerator);
    }

    private findSpecPath = async (specName: string) : Promise<string | undefined> => {
        // Enumerate all specs and get path for the match
        const specs = await this.enumerateSpecs();
        const match = specs.find(s => {
            const js = s as JupyterKernelSpec;
            return js && js.name === specName;
        }) as JupyterKernelSpec;
        return match ? match.specFile : undefined;
    }

    private async generateTempFile() : Promise<string> {
        // Create a temp file on disk
        const file = await this.fileSystem.createTemporaryFile('.ipynb');

        // Save in our list disposable
        this.disposableRegistry.push(file);

        return file.filePath;
    }

    private isCommandSupported = async (command: string) : Promise<boolean> => {
        // See if we can find the command
        try {
            const result = this.findBestCommand(command);
            return result !== undefined;
        } catch (err) {
            this.logger.logWarning(err);
            return false;
        }
    }

    /**
     * Conda needs specific paths and env vars set to be happy. Call this function to fix up
     * (or created if not present) our environment to run jupyter
     */
    // Base Node.js SpawnOptions uses any for environment, so use that here as well
    // tslint:disable-next-line:no-any
    private fixupCondaEnv = async (inputEnv: any | undefined): Promise<any> => {
        if (!inputEnv) {
            inputEnv = process.env;
        }
        const interpreter = await this.interpreterService.getActiveInterpreter();
        if (interpreter && interpreter.type === InterpreterType.Conda) {
            return this.condaService.getActivatedCondaEnvironment(interpreter, inputEnv);
        }

        return inputEnv;
    }

    private hasSpecPathMatch = async () : Promise<boolean> => {
        // First get our current python path
        const pythonService = await this.executionFactory.create({});
        const info = await pythonService.getInterpreterInformation();

        // Then enumerate our specs
        const specs = await this.enumerateSpecs();

        // See if any of their paths match
        return specs.findIndex(s => info && s.path === info.path) >= 0;
    }

    //tslint:disable-next-line:cyclomatic-complexity
    private findSpecMatch = async (enumerator: () => Promise<IJupyterKernelSpec[]>) : Promise<IJupyterKernelSpec | undefined> => {
        // Extract our current python information that the user has picked.
        // We'll match against this.
        const pythonService = await this.executionFactory.create({});
        const info = await pythonService.getInterpreterInformation();
        let bestScore = 0;
        let bestSpec : IJupyterKernelSpec | undefined;

        // Then enumerate our specs
        const specs = await enumerator();

        for (let i = 0; specs && i < specs.length; i += 1) {
            const spec = specs[i];
            let score = 0;

            if (spec.path.length > 0 && info && spec.path === info.path) {
                // Path match
                score += 10;
            }
            if (spec.language.toLocaleLowerCase() === 'python') {
                // Language match
                score += 1;

                // See if the version is the same
                const fs = await import ('fs-extra');
                if (info && info.version_info && spec.path.length > 0 && await fs.pathExists(spec.path)) {
                    const details = await this.interpreterService.getInterpreterDetails(spec.path);
                    if (details && details.version_info) {
                        if (details.version_info[0] === info.version_info[0]) {
                            // Major version match
                            score += 4;

                            if (details.version_info[1] === info.version_info[1]) {
                                // Minor version match
                                score += 2;

                                if (details.version_info[2] === info.version_info[2]) {
                                    // Minor version match
                                    score += 1;
                                }
                            }
                        }
                    }
                } else if (info && info.version_info && spec.path.toLocaleLowerCase() === 'python') {
                    // This should be our current python.

                    // Search for a digit on the end of the name. It should match our major version
                    const match = /\D+(\d+)/.exec(spec.name);
                    if (match && match !== null && match.length > 0) {
                        // See if the version number matches
                        const nameVersion = parseInt(match[0], 10);
                        if (nameVersion && nameVersion === info.version_info[0]) {
                            score += 4;
                        }
                    }
                }
            }

            // Update high score
            if (score > bestScore) {
                bestScore = score;
                bestSpec = spec;
            }
        }

        // If still not set, at least pick the first one
        if (!bestSpec && specs && specs.length > 0) {
            bestSpec = specs[0];
        }

        return bestSpec;
    }

    private getActiveKernelSpecs = async (connection: IConnection) : Promise<IJupyterKernelSpec[]> => {
        // Use our connection to create a session manager
        const serverSettings = ServerConnection.makeSettings(
            {
                baseUrl: connection.baseUrl,
                token: connection.token,
                pageUrl: '',
                // A web socket is required to allow token authentication (todo: what if there is no token authentication?)
                wsUrl: connection.baseUrl.replace('http', 'ws'),
                init: { cache: 'no-store', credentials: 'same-origin' }
            });
        const sessionManager = new SessionManager({ serverSettings: serverSettings });

        // Ask the session manager to refresh its list of kernel specs.
        await sessionManager.refreshSpecs();

        // Enumerate all of the kernel specs, turning each into a JupyterKernelSpec
        const kernelspecs = sessionManager.specs && sessionManager.specs.kernelspecs ? sessionManager.specs.kernelspecs : {};
        const keys = Object.keys(kernelspecs);
        return keys.map(k => {
            const spec = kernelspecs[k];
            return new JupyterKernelSpec(spec);
        });
    }

    private enumerateSpecs = async () : Promise<IJupyterKernelSpec[]> => {
        if (await this.isKernelSpecSupported()) {
            const kernelSpecCommand = await this.findBestCommand('kernelspec');

            // Ask for our current list.
            const list = await kernelSpecCommand.exec(['list'], { throwOnStdErr: true, encoding: 'utf8' });

            // This should give us back a key value pair we can parse
            const result: IJupyterKernelSpec[] = [];
            const lines = list.stdout.splitLines({ trim: false, removeEmptyEntries: true });
            for (let i = 0; i < lines.length; i += 1) {
                const match = /^\s+(\S+)\s*(\S+)$/.exec(lines[i]);
                if (match && match !== null && match.length > 2) {
                    // Lazy import our node_modules
                    const path = await import('path');
                    const fs = await import('fs-extra');

                    // Second match should be our path to the kernel spec
                    const file = path.join(match[2], 'kernel.json');
                    if (await fs.pathExists(file)) {
                        // Turn this into a IJupyterKernelSpec
                        const model = await fs.readJSON(file, { encoding: 'utf8' });
                        model.name = match[1];
                        result.push(new JupyterKernelSpec(model));
                    }
                }
            }

            return result;
        }

        return [];
    }

    private findInterpreterCommand = async (command: string, interpreter: PythonInterpreter) : Promise<JupyterCommand | undefined> => {
        // If the module is found on this interpreter, then we found it.
        if (interpreter && await this.doesModuleExist(command, interpreter)) {
            // We need a process service to create a command
            const processService = await this.processServicePromise;
            return new JupyterCommand(interpreter.path, [command], processService, this.interpreterService, this.condaService);
        }

        return undefined;
    }

    private lookForJupyterInDirectory = async (pathToCheck: string): Promise<string[]> => {
        try {
            const path = await import('path');
            const subdirs = await fsReaddirAsync(pathToCheck);
            return subdirs.filter(s => {
                CheckJupyterRegEx.test(path.basename(s));
            });

        } catch (err) {
            this.logger.logWarning('Python Extension (lookForJupyterInDirectory.fsReaddirAsync):', err);
        }
        return [] as string[];
    }

    private searchPathsForJupyter = async () : Promise<string | undefined> => {
        if (!this.jupyterPath) {
            const paths = this.knownSearchPaths.getSearchPaths();
            for (let i=0; i < paths.length && !this.jupyterPath; i += 1) {
                const found = await this.lookForJupyterInDirectory(paths[i]);
                if (found.length > 0) {
                    this.jupyterPath = found[0];
                }
            }
        }
        return this.jupyterPath;
    }

    private findPathCommand = async (command: string) : Promise<JupyterCommand | undefined> => {
        if (await this.doesJupyterCommandExist(command)) {
            // Search the known paths for jupyter
            const jupyterPath = await this.searchPathsForJupyter();
            if (jupyterPath) {
                // We need a process service to create a command
                const processService = await this.processServicePromise;
                return new JupyterCommand(jupyterPath, [command], processService, this.interpreterService, this.condaService);
            }
        }
        return undefined;
    }

    // For jupyter,
    // - Look in current interpreter, if found create something that has path and args
    // - Look in other interpreters, if found create something that has path and args
    // - Look on path, if found create something that has path and args
    // For general case
    // - Look for module in current interpreter, if found create something with python path and -m module
    // - Look in other interpreters, if found create something with python path and -m module
    // - Look on path for jupyter, if found create something with jupyter path and args
    private findBestCommand = async (command: string) : Promise<JupyterCommand | undefined> => {
        // See if we already have this command in list
        if (!this.commands.hasOwnProperty(command)) {
            // Not found, try to find it.

            // First we look in the current interpreter
            const current = await this.interpreterService.getActiveInterpreter();
            let found = await this.findInterpreterCommand(command, current);
            if (!found) {
                // Look through all of our interpreters (minus the active one)
                const all = await this.interpreterService.getInterpreters();
                for (let i=0; i < all.length && !found; i += 1) {
                    if (current !== all[i]) {
                        found = await this.findInterpreterCommand(command, all[i]);
                    }
                }
            }

            // If still not found, try looking on the path using jupyter
            if (!found) {
                found = await this.findPathCommand(command);
            }

            // If we found a command, save in our dictionary
            if (found) {
                this.commands[command] = found;
            }
        }

        // Return result
        return this.commands.hasOwnProperty(command) ? this.commands[command] : undefined;
    }

    private doesModuleExist = async (module: string, interpreter: PythonInterpreter): Promise<boolean> => {
        const newOptions : SpawnOptions = {throwOnStdErr: true, encoding: 'utf8'};
        newOptions.env = await this.fixupCondaEnv(newOptions.env);
        const pythonService = await this.executionFactory.create({ pythonPath: interpreter.path });
        try {
            const result = await pythonService.execModule(module, ['--version'], newOptions);
            return !result.stderr;
        } catch (err) {
            this.logger.logWarning(err);
            return false;
        }
    }

    private doesJupyterCommandExist = async (command?: string) : Promise<boolean> => {
        const newOptions : SpawnOptions = {throwOnStdErr: true, encoding: 'utf8'};
        const args = command ? [...command] : [];
        const processService = await this.processServicePromise;
        try {
            const result = await processService.exec('jupyter', args, newOptions);
            return !result.stderr;
        } catch (err) {
            this.logger.logWarning(err);
            return false;
        }
    }

}
