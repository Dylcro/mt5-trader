import { Router, type IRouter } from "express";
import mt5Router from "./mt5";
import supportRouter from "./support";
import { seedKnownAccountsFromDb, deleteOrphanZones } from "./mt5";
const router: IRouter = Router();

router.use(supportRouter);
router.use(mt5Router);

void seedKnownAccountsFromDb();
void deleteOrphanZones();

export default router;
