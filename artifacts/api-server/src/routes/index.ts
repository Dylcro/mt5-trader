import { Router, type IRouter } from "express";
import healthRouter from "./health";
import mt5Router from "./mt5";
import supportRouter from "./support";
import adminRouter from "./admin";

const router: IRouter = Router();

router.use(healthRouter);
router.use(mt5Router);
router.use(supportRouter);
router.use(adminRouter);

export default router;
