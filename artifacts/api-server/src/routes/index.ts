import { Router, type IRouter } from "express";
import mt5Router from "./mt5";
import supportRouter from "./support";
const router: IRouter = Router();

router.use(supportRouter);
router.use(mt5Router);

export default router;
