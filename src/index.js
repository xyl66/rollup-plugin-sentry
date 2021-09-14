const SentryCli = require('@sentry/cli');
const util = require('util');
const fs = require('fs');
const path = require('path');

const DEFAULT_DELETE_REGEX = /\.map$/;
/**
 * Helper function that ensures an object key is defined. This mutates target!
 *
 * @param {object} target The target object
 * @param {string} key The object key
 * @param {function} factory A function that creates the new element
 * @returns {any} The existing or created element.
 */
function ensure(target, key, factory) {
  // eslint-disable-next-line no-param-reassign
  target[key] = typeof target[key] !== 'undefined' ? target[key] : factory();
  return target[key];
}
function toArray(value) {
  if (Array.isArray(value) || value === null || value === undefined) {
    return value;
  }

  return [value];
}
class MyPlugin {
  constructor(options = {}) {
    const defaults = {
      finalize: true,
      rewrite: true,
    };
    this.deleteRegex = options.deleteRegex || DEFAULT_DELETE_REGEX;
    this.options = Object.assign({}, defaults, options);
    this.config = null;
    // the webpack plugin has looser type requirements than `@sentry/cli` -
    // ensure `include` and `ignore` options are in the right format
    if (options.include) {
      this.options.include = toArray(options.include);
      this.options.include.forEach(includeEntry => {
        if (
          typeof includeEntry === 'object' &&
          includeEntry.ignore !== undefined
        ) {
          // eslint-disable-next-line no-param-reassign
          includeEntry.ignore = toArray(includeEntry.ignore);
        }
      });
    }

    if (options.ignore) this.options.ignore = toArray(options.ignore);

    this.cli = this.getSentryCli();
    this.release = this.getReleasePromise();
  }

  setConfig(_config) {
    this.config = _config;
  }

  /** Creates a new Sentry CLI instance. */
  getSentryCli() {
    const cli = new SentryCli(this.options.configFile, {
      silent: this.isSilent(),
      org: this.options.org,
      project: this.options.project,
      authToken: this.options.authToken,
      url: this.options.url,
      vcsRemote: this.options.vcsRemote,
    });

    if (this.isDryRun()) {
      this.outputDebug('DRY Run Mode');

      return {
        releases: {
          proposeVersion: () =>
            cli.releases.proposeVersion().then(version => {
              this.outputDebug('Proposed version:\n', version);
              return version;
            }),
          new: release => {
            this.outputDebug('Creating new release:\n', release);
            return Promise.resolve(release);
          },
          uploadSourceMaps: (release, config) => {
            this.outputDebug('Calling upload-sourcemaps with:\n', config);
            return Promise.resolve(release, config);
          },
          finalize: release => {
            this.outputDebug('Finalizing release:\n', release);
            return Promise.resolve(release);
          },
          setCommits: (release, config) => {
            this.outputDebug('Calling set-commits with:\n', config);
            return Promise.resolve(release, config);
          },
          newDeploy: (release, config) => {
            this.outputDebug('Calling deploy with:\n', config);
            return Promise.resolve(release, config);
          },
        },
      };
    }

    return cli;
  }

  /**
   * Returns a Promise that will solve to the configured release.
   *
   * If no release is specified, it uses Sentry CLI to propose a version.
   * The release string is always trimmed.
   * Returns undefined if proposeVersion failed.
   */
  getReleasePromise() {
    return (this.options.release
      ? Promise.resolve(this.options.release)
      : this.cli.releases.proposeVersion()
    )
      .then(version => `${version}`.trim())
      .catch(() => undefined);
  }

  /**
   * Pretty-prints debug information
   *
   * @param {string} label Label to be printed as a prefix for the data
   * @param {any} data Input to be pretty-printed
   */
  outputDebug(label, data) {
    if (this.isSilent()) {
      return;
    }
    if (data !== undefined) {
      // eslint-disable-next-line no-console
      console.warn(
        `[Sentry Webpack Plugin] ${label} ${util.inspect(
          data,
          false,
          null,
          true
        )}`
      );
    } else {
      // eslint-disable-next-line no-console
      console.warn(`[Sentry Webpack Plugin] ${label}`);
    }
  }

  /** Returns whether this plugin should emit any data to stdout. */
  isSilent() {
    return this.options.silent === true;
  }

  /** Returns whether this plugin is in dryRun mode. */
  isDryRun() {
    return this.options.dryRun === true;
  }

  /** Creates and finalizes a release on Sentry. */
  async finalizeRelease(_options) {
    const { include } = _options;

    let release;
    return new Promise((resolve, reject) => {
      this.release
        .then(proposedVersion => {
          release = proposedVersion;

          if (!include) {
            throw new Error(`\`include\` option is required`);
          }

          if (!release) {
            throw new Error(
              `Unable to determine version. Make sure to include \`release\` option or use the environment that supports auto-detection https://docs.sentry.io/cli/releases/#creating-releases`
            );
          }
          return this.cli.releases.new(release);
        })
        .then(() => {
          if (_options.cleanArtifacts) {
            return this.cli.releases.execute(
              ['releases', 'files', release, 'delete', '--all'],
              true
            );
          }
          return undefined;
        })
        .then(() => this.cli.releases.uploadSourceMaps(release, _options))
        .then(() => {
          const {
            commit,
            previousCommit,
            repo,
            auto,
            ignoreMissing,
            ignoreEmpty,
          } = _options.setCommits || _options;

          if (auto || (repo && commit)) {
            return this.cli.releases.setCommits(release, {
              commit,
              previousCommit,
              repo,
              auto,
              ignoreMissing,
              ignoreEmpty,
            });
          }
          return undefined;
        })
        .then(() => {
          if (_options.finalize) {
            return this.cli.releases.finalize(release);
          }
          return undefined;
        })
        .then(() => {
          const { env, started, finished, time, name, url } =
            _options.deploy || {};

          if (env) {
            const res = this.cli.releases.newDeploy(release, {
              env,
              started,
              finished,
              time,
              name,
              url,
            });
            return resolve(res);
          }
          return resolve(undefined);
        })
        .catch(err => {
          reject(new Error(`Sentry CLI Plugin: ${err.message}`));
        });
    });
  }

  // eslint-disable-next-line class-methods-use-this
  getAssetPath(assetsPath, name) {
    return path.join(assetsPath, name.split('?')[0]);
  }

  async deleteFiles() {
    if (!this.options.deleteAfterCompile) {
      return;
    }
    const { build } = this.config;
    const assetsPath = `${build.outDir}/${build.assetsDir}`;
    const assets = await fs.readdirSync(
      path.resolve(process.cwd(), assetsPath)
    );
    assets
      .filter(name => this.deleteRegex.test(name))
      .forEach(name => {
        const filePath = this.getAssetPath(assetsPath, name);
        if (filePath) {
          fs.unlinkSync(filePath);
        } else {
          // eslint-disable-next-line no-console
          console.warn(
            `WebpackSentryPlugin: unable to delete '${name}'. ` +
              'File does not exist; it may not have been created ' +
              'due to a build error.'
          );
        }
      });
  }
}

function rollupSentry(options = {}) {
  const plugInstance = new MyPlugin(options);
  let config;
  return {
    name: 'rollup-sentry', // 必须的，将会在 warning 和 error 中显示
    async configResolved(resolvedConfig) {
      // 存储最终解析的配置
      config = resolvedConfig;
      plugInstance.setConfig(config);
    },
    async closeBundle() {
      if (!options.include || !options.include.length) {
        ensure(config, 'build', Object);
        if (config.build.outDir) {
          // eslint-disable-next-line no-param-reassign
          options.include = [config.build.outDir];
        }
      }
      try {
        await plugInstance.finalizeRelease(options);
        await plugInstance.deleteFiles();
      } catch (error) {
        console.warn(error);
      }
    },
  };
}
module.exports.default = rollupSentry;
