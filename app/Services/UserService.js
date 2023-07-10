import {generateConfirmUrl, hashHmacString, responseErrors, responseSuccess} from "../Common/helper.js";
import {ACTION_LOGS, DEFAULT_PASWORD, JOB_QUEUES, STORAGE_PATHS, USER_IMPORTS, USERS} from "../../config/constant.js";
import UserRepository from "../Repositories/UserRepository.js";
import EmailService from "./EmailService.js";
import ActionLogRepository from "../Repositories/ActionLogRepository.js";
import AdminNamespace from "../Socket/Namespaces/Admin/AdminNamespace.js";
import * as XLSX from 'xlsx/xlsx.mjs';
import * as fs from 'fs';
import UserImportRepository from "../Repositories/UserImportRepository.js";
import HttpError from "../Exceptions/HttpError.js";
import Bull from "bull";
import winston from "winston";

XLSX.set_fs(fs);

class UserService {
  constructor()
  {
    this.userRepository = new UserRepository();
    this.emailService = new EmailService();
    this.actionLogRepository = new ActionLogRepository();
    this.socketAdminNamespace = new AdminNamespace();
    this.userImportRepository = new UserImportRepository();
  }

  index (params)
  {
    return this.userRepository.paginate(params.query, {
      page: +params.query?.pagination?.page,
      limit: +params.query?.pagination?.limit
    })
  }

  async storeUser (params, authUser)
  {
    try {
      params.password = hashHmacString(DEFAULT_PASWORD);
      const insertedUser = await this.userRepository.store(params, authUser);
      this.emailService.sendMail(
        [params.email],
        'Confirm Account Base Admin',
        'email/confirmAccount.ejs',
        {
            name: params.name,
            confirmUrl: generateConfirmUrl(insertedUser.id)
        }
      );
      const user = insertedUser;
      this.actionLogRepository.store(
        {
          name: ACTION_LOGS.name.admin_create_new_user,
          type: ACTION_LOGS.type.admin_create_new_user,
          meta_data: JSON.stringify(
            {
              new_user: user
            }
          ),
        },
        authUser
      )
      this.socketAdminNamespace.emitCreateNewUser(user);
      return Promise.resolve(user);
    } catch (e) {
      return Promise.reject(e);
    }
  }

  show (userId)
  {
    return this.userRepository.findById(userId);
  }

  update(userId, params, authUser)
  {
    return this.userRepository.update(userId, params, authUser)
  }

  destroy(userId)
  {
    return this.userRepository.delete(userId);
  }

  async import(params, authUser)
  {
    try {
      const wb = XLSX.readFile(params.file.path);
      const users = XLSX.utils.sheet_to_json(
        wb.Sheets[wb.SheetNames[0]],
        {
          header:['name', 'phone', 'email'],
          range:1
        }
      )

      if (!users.length) {
        throw new HttpError('Danh sách users trống', 422);
      }
      const storeUserImport = await this.userImportRepository.store(
        {
          path: STORAGE_PATHS.importUsers + params.file.filename,
        },
        authUser
      )
      const userImportQueue = new Bull(JOB_QUEUES.userImports,  {
        redis: { host: "127.0.0.1", port: 6379 }
      });
      userImportQueue.add({
        users,
        userImport: storeUserImport
      });
      userImportQueue.process(async (job, done) => {
        const users = job.data.users;
        const userImport = job.data.userImport || job.data.storeUserImport;
        let errors = [];
        await this.userImportRepository.update(userImport._id, {
          status: USER_IMPORTS.status.processing
        })

        for (const user of users) {
          const originUser = {...user};
          user.level = USERS.level.user;
          try {
            await this.storeUser(user);
          } catch (e) {
            errors.push({
              user:originUser,
              error: e.message
            });
          }
        }
        await this.userImportRepository.update(userImport._id, {
          status: USER_IMPORTS.status.done,
          has_errors: errors.length ? USER_IMPORTS.has_errors.true : USER_IMPORTS.has_errors.false,
          log: errors.length ? JSON.stringify({errors}) : ''
        })
        done();
      });
      winston.loggers.get('user_imports').info('Import Success')
    } catch (e) {
      winston.loggers.get('user_imports').error('Import Error', e)
    }
  }

  showImportNewest()
  {
    return this.userImportRepository.showNewest();
  }

  async getImportHistory()
  {
    return this.userImportRepository.findBy({}, {
        created_at: -1
      })
      .then(
        (userImports) => {
          userImports = JSON.parse(JSON.stringify(userImports)).map(
            userImport => {
              try {
                const wb = XLSX.readFile(userImport.path);
                userImport.file = XLSX.write(wb, {
                  type: "buffer",
                  bookType: "xlsx"
                });
              } catch (e) {
                userImport.file = null;
              }

              return userImport;
            }
          );
          return Promise.resolve(userImports);
        }
      )
      .catch(
        (e) => {
          return Promise.reject(e)
        }
      );
  }

  async export(params)
  {
    let users = await this.userRepository.findBy(params.body);
    users = users.map(
      user => [user.name, user.email, user.phone]
    );
    const ws = XLSX.utils.aoa_to_sheet([['name', 'email', 'phone'], ...users]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Data");
    const buf = XLSX.write(wb, {
      type: "buffer",
      bookType: "xlsx"
    });

    return buf;
  }
}

export default UserService;